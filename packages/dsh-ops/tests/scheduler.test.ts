/**
 * Host scheduler contract: a due boundary starts one run, an active cron run
 * suppresses overlapping boundaries, and a disabled schedule never fires.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '../src/store.ts'
import { TaskScheduler } from '../src/scheduler.ts'
import type { TaskRunner } from '../src/runner.ts'
import type { OpsTask } from '../src/protocol.ts'

/** A runner that records starts and holds each wait until the test releases it. */
class FakeRunner {
  readonly started: string[] = []
  private readonly waiters: Array<() => void> = []

  async start(taskId: string): Promise<{ id: string }> {
    this.started.push(taskId)
    return { id: `run-${this.started.length}` }
  }

  async wait(): Promise<void> {
    await new Promise<void>((resolve) => { this.waiters.push(resolve) })
  }

  finish(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

/** Flush microtasks without timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** One service/server/task with an every-minute schedule. */
function fixture(enabled: boolean): { store: OpsStore; task: OpsTask } {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ops-scheduler-'))
  const store = new OpsStore(join(dir, 'definitions.json'))
  const system = store.createSystem({ name: '交易系统' })
  const service = store.createService({ systemId: system.id, name: '订单服务' })
  store.createServer({ serviceId: service.id, sshAlias: 'app1-01', runtime: { kind: 'systemd' } })
  const task = store.createTask({
    owner: { kind: 'service', id: service.id },
    name: '每分钟巡检',
    script: '#!/bin/bash\ntrue\n',
    schedule: { enabled, cron: '* * * * *' },
  })
  return { store, task }
}

describe('cron scheduler', () => {
  it('operator with an enabled schedule sees one run per boundary and no overlap', async () => {
    // Given a task scheduled every minute and a controlled clock
    const { store, task } = fixture(true)
    const runner = new FakeRunner()
    let now = Date.UTC(2026, 0, 1, 12, 0, 30)
    const scheduler = new TaskScheduler(store, runner as unknown as TaskRunner, { now: () => now })

    // When the first pass observes the schedule, the next boundary is computed
    scheduler.tick()
    expect(runner.started).toEqual([])

    // And the boundary passes while no run is active
    now = Date.UTC(2026, 0, 1, 12, 1, 5)
    scheduler.tick()
    expect(runner.started).toEqual([task.id])
    expect(store.task(task.id)?.schedule?.lastRunAt).toBe(now)
    // Let the started run register its wait before the test releases it.
    await flush()

    // Then the next boundary while the run is still active is suppressed
    now = Date.UTC(2026, 0, 1, 12, 2, 5)
    scheduler.tick()
    expect(runner.started).toEqual([task.id])

    // And after the run settles the following boundary starts a new run
    runner.finish()
    await flush()
    now = Date.UTC(2026, 0, 1, 12, 3, 5)
    scheduler.tick()
    expect(runner.started).toEqual([task.id, task.id])
    scheduler.stop()
  })

  it('operator with a disabled schedule sees no run at any boundary', () => {
    // Given a task whose schedule is disabled
    const { store, task } = fixture(false)
    const runner = new FakeRunner()
    let now = Date.UTC(2026, 0, 1, 12, 0, 30)
    const scheduler = new TaskScheduler(store, runner as unknown as TaskRunner, { now: () => now })
    scheduler.tick()

    // When several minute boundaries pass
    for (const minute of [1, 2, 3]) {
      now = Date.UTC(2026, 0, 1, 12, minute, 5)
      scheduler.tick()
    }

    // Then nothing was started
    expect(runner.started).toEqual([])
    expect(store.task(task.id)?.schedule?.lastRunAt).toBeUndefined()
    scheduler.stop()
  })
})
