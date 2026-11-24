/**
 * Run records and per-target logs.
 *
 * One JSON file per run plus one log file per target, all under
 * `$DSH_HOME/ops/runs/`. A bounded index (`index.json`) keeps the history list
 * cheap: the browser reads the index, and only opens one run file when a run
 * is selected. Logs are append-only and read back by tail, so a long-running
 * deployment does not load the whole file into the UI.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { opsDir } from './store.ts'
import type { OpsRun, RunSummary } from './protocol.ts'

/** How many summaries the index keeps. */
const INDEX_LIMIT = 200

/** Default tail window the browser reads. */
export const DEFAULT_LOG_TAIL_BYTES = 192 * 1024

/** New run identifier. */
export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** Project a run onto its list row. */
export function summarizeRun(run: OpsRun): RunSummary {
  return {
    id: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    source: run.source,
    status: run.status,
    targetCount: run.targets.length,
    okCount: run.targets.filter(target => target.status === 'ok').length,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  }
}

/** The run/log store. Pure file I/O, unit-testable. */
export class RunStore {
  /** Run root. */
  readonly dir: string
  /** Per-run JSON directory (same as root). */
  readonly indexPath: string

  /**
   * @param dir - run root (defaults to `$DSH_HOME/ops/runs`).
   */
  constructor(dir?: string) {
    this.dir = dir ?? join(opsDir(), 'runs')
    this.indexPath = join(this.dir, 'index.json')
  }

  /** Recent run summaries, newest first. */
  list(limit = 50): RunSummary[] {
    const all = this.readIndex()
    return all.slice(0, Math.max(1, limit))
  }

  /** One run record. */
  get(id: string): OpsRun | undefined {
    if (!existsSync(this.runPath(id))) return undefined
    try {
      return JSON.parse(readFileSync(this.runPath(id), 'utf8')) as OpsRun
    } catch {
      return undefined
    }
  }

  /** Persist a new run and prepend it to the index. */
  create(run: OpsRun): void {
    this.ensureDir()
    this.writeRun(run)
    const index = this.readIndex().filter(entry => entry.id !== run.id)
    index.unshift(summarizeRun(run))
    this.writeIndex(index.slice(0, INDEX_LIMIT))
  }

  /** Persist a run update and refresh its index row. */
  update(run: OpsRun): void {
    this.ensureDir()
    this.writeRun(run)
    const index = this.readIndex()
    const row = summarizeRun(run)
    const at = index.findIndex(entry => entry.id === run.id)
    if (at < 0) {
      index.unshift(row)
    } else {
      index[at] = row
    }
    this.writeIndex(index.slice(0, INDEX_LIMIT))
  }

  /** Append one target's output chunk to its log. */
  appendLog(runId: string, serverId: string, text: string): void {
    if (text === '') return
    this.ensureDir()
    const path = this.logPath(runId, serverId)
    const parent = dirname(path)
    // One directory per run holds that run's per-target logs; mkdir -p keeps
    // the first append from racing the run's own creation.
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 })
    appendFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
  }

  /** Read the tail of one target's log. */
  readLog(runId: string, serverId: string, maxBytes = DEFAULT_LOG_TAIL_BYTES): string {
    const path = this.logPath(runId, serverId)
    if (!existsSync(path)) return ''
    try {
      const size = statSync(path).size
      const text = readFileSync(path, 'utf8')
      if (size <= maxBytes) return text
      // Slice by characters after the byte cap: close enough for a tail view
      // and always safe for UTF-8 boundaries when sliced on the text.
      return text.slice(-maxBytes)
    } catch {
      return ''
    }
  }

  /** Log file path for one target (deterministic; also used by clients). */
  logPath(runId: string, serverId: string): string {
    return join(this.dir, 'logs', safeSegment(runId), `${safeSegment(serverId)}.log`)
  }

  // ------------------------------------------------------------ internals

  /** One run file path. */
  private runPath(id: string): string {
    return join(this.dir, `${safeSegment(id)}.json`)
  }

  /** Read the index (missing/corrupt reads as empty). */
  private readIndex(): RunSummary[] {
    if (!existsSync(this.indexPath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is RunSummary =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as RunSummary).id === 'string'
        && typeof (entry as RunSummary).taskName === 'string')
    } catch {
      return []
    }
  }

  /** Atomically write the index. */
  private writeIndex(index: RunSummary[]): void {
    this.ensureDir()
    const tmp = this.indexPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.indexPath)
  }

  /** Atomically write one run record. */
  private writeRun(run: OpsRun): void {
    this.ensureDir()
    const tmp = this.runPath(run.id) + '.tmp'
    writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.runPath(run.id))
  }

  /** Create the run/log directories (0700). */
  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const logs = join(this.dir, 'logs')
    if (!existsSync(logs)) mkdirSync(logs, { recursive: true, mode: 0o700 })
  }
}

/** One path segment safe for use under the run directory. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
}
