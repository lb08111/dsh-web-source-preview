/**
 * Host-side cron scheduler: reads enabled schedules from the definitions
 * ledger, starts a run at each due boundary, and records the trigger time.
 *
 * The scheduler never queues a second occurrence while the previous cron run
 * of the same task is still active (the runner already serializes targets per
 * server, but a queue would make a slow task fire in bursts once it finishes).
 * Missed occurrences during Host downtime are skipped, matching the family's
 * scheduler semantics.
 */

import { nextRunAtMs } from './schedule.ts'
import type { OpsTask } from './protocol.ts'
import type { TaskRunner } from './runner.ts'
import type { OpsStore } from './store.ts'

/** Default scheduler pass interval. */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 20_000

/** Scheduler knobs (tests inject the clock). */
export interface SchedulerOptions {
  intervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

/** The cron scheduler. */
export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly next = new Map<string, number>()
  private readonly signatures = new Map<string, string>()
  private readonly running = new Set<string>()
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly onError: (error: unknown) => void

  /**
   * @param store - definitions ledger.
   * @param runner - the task runner cron runs go through.
   * @param options - interval/clock/error hooks.
   */
  constructor(
    private readonly store: OpsStore,
    private readonly runner: TaskRunner,
    options: SchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? ((error: unknown) => {
      console.warn('[dsh-ops] scheduled run failed:', error)
    })
  }

  /** Start the periodic pass (idempotent). */
  start(): void {
    if (this.timer !== undefined) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  /** Stop the periodic pass. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.next.clear()
    this.signatures.clear()
  }

  /**
   * One scheduler pass. Public so tests can drive it with a fake clock.
   */
  tick(): void {
    const now = this.now()
    for (const task of this.store.tasks()) {
      const schedule = task.schedule
      const signature = schedule === undefined
        ? ''
        : `${schedule.enabled ? '1' : '0'}|${schedule.cron}|${schedule.timeZone ?? ''}`
      if (this.signatures.get(task.id) !== signature) {
        this.signatures.set(task.id, signature)
        this.next.delete(task.id)
      }
      if (schedule === undefined || !schedule.enabled) continue

      const due = this.next.get(task.id)
      if (due === undefined) {
        // First observation: start from the next boundary, never fire a
        // boundary that belonged to the past.
        this.scheduleNext(task, now)
        continue
      }
      if (due > now) continue

      this.next.delete(task.id)
      this.scheduleNext(task, now)
      if (this.running.has(task.id)) continue

      this.running.add(task.id)
      this.store.markScheduleRun(task.id, now)
      void this.runner.start(task.id, { source: 'cron' })
        .then(run => this.runner.wait(run.id))
        .catch((error: unknown) => { this.onError(error) })
        .finally(() => {
          this.running.delete(task.id)
          // Recompute from completion so a slow task does not replay every
          // boundary it overlapped.
          this.scheduleNext(task, this.now())
        })
    }
  }

  /** Compute and store the next boundary for one task. */
  private scheduleNext(task: OpsTask, from: number): void {
    if (task.schedule === undefined || !task.schedule.enabled) {
      this.next.delete(task.id)
      return
    }
    const at = nextRunAtMs(task.schedule.cron, from + 1000, task.schedule.timeZone)
    if (at === undefined) this.next.delete(task.id)
    else this.next.set(task.id, at)
  }
}
