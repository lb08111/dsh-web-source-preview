/**
 * Task runner: resolve targets and parameters, upload file parameters, execute
 * the script through `bash -s` on stdin, and stream output into per-target
 * logs while keeping the run record current.
 *
 * Targets run serially in this milestone (safest for test environments) and a
 * per-alias mutex prevents two runs from touching the same server at once.
 * A run is started fire-and-forget from the route; `wait()` exists for tests
 * and for graceful shutdown.
 */

import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { FlowStep, OpsRun, OpsServer, OpsTask, RunInput, TaskParam } from './protocol.ts'
import type { OpsTransport } from './transport.ts'
import { BUILTIN_ENV } from './templates.ts'
import type { OpsStore } from './store.ts'
import { newRunId, type RunStore } from './runs.ts'
import { sendRunWebhook } from './notify.ts'

/** One validated run plan. */
export interface RunPlan {
  task: OpsTask
  targets: OpsServer[]
  /** Global parameter values (server overrides are applied per target). */
  params: Record<string, string>
}

/** Single-quote a shell value (newlines and embedded quotes preserved). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Normalize one declared parameter value, or refuse it. */
function normalizeParamValue(param: TaskParam, raw: string): string {
  if (param.type === 'number') {
    if (raw.trim() === '' || !Number.isFinite(Number(raw))) {
      throw new Error(`parameter '${param.name}' must be a number`)
    }
    return String(Number(raw))
  }
  if (param.type === 'boolean') {
    if (raw === 'true' || raw === '1') return 'true'
    if (raw === 'false' || raw === '0') return 'false'
    throw new Error(`parameter '${param.name}' must be true or false`)
  }
  if (param.type === 'select') {
    const options = param.options ?? []
    if (!options.includes(raw)) throw new Error(`parameter '${param.name}' must be one of: ${options.join(', ')}`)
    return raw
  }
  return raw
}

/**
 * Resolve one task's parameter values for a target.
 *
 * Precedence: declared default < server override < caller input.
 * @param task - the task definition.
 * @param input - caller-provided values.
 * @param server - target server whose overrides apply (omitted for the plan-wide view).
 * @returns the values to inject as environment variables.
 */
export function resolveTaskParams(
  task: OpsTask,
  input: Record<string, string> = {},
  server?: OpsServer,
): Record<string, string> {
  const overrides = server === undefined ? {} : task.serverOverrides?.[server.id]?.params ?? {}
  const resolved: Record<string, string> = {}
  for (const param of task.params) {
    const raw = input[param.name] ?? overrides[param.name] ?? param.default
    if (raw === undefined || raw === '') {
      if (param.required === true) throw new Error(`parameter '${param.name}' is required`)
      continue
    }
    resolved[param.name] = normalizeParamValue(param, String(raw))
  }
  return resolved
}

/**
 * Validate a run request into a plan (targets + parameter values).
 * @param store - the definitions ledger.
 * @param taskId - task to run.
 * @param input - caller request.
 * @returns the resolved plan.
 */
export function planRun(store: OpsStore, taskId: string, input: Omit<RunInput, 'taskId'> = {}): RunPlan {
  const task = store.task(taskId)
  if (task === undefined) throw new Error(`task '${taskId}' not found`)
  const allowed = store.targetsOfTask(task)
  if (allowed.length === 0) throw new Error('this task has no target servers')

  let targets = allowed
  if (input.serverIds !== undefined && input.serverIds.length > 0) {
    const allowedIds = new Set(allowed.map(server => server.id))
    const unknown = input.serverIds.filter(id => !allowedIds.has(id))
    if (unknown.length > 0) throw new Error(`server(s) outside this task's scope: ${unknown.join(', ')}`)
    const wanted = new Set(input.serverIds)
    targets = allowed.filter(server => wanted.has(server.id))
    if (targets.length === 0) throw new Error('no target servers selected')
  }

  const params = resolveTaskParams(task, input.params ?? {})
  for (const param of task.params) {
    if (param.type !== 'file') continue
    const local = params[param.name]
    if (local === undefined || local === '') continue
    if (!existsSync(local) || !statSync(local).isFile()) {
      throw new Error(`parameter '${param.name}' must be an existing local file path`)
    }
  }
  return { task, targets, params }
}

/** Built-in environment variables for one target. */
export function builtinEnv(server: OpsServer, runId: string): Record<string, string> {
  return {
    [BUILTIN_ENV.runId]: runId,
    [BUILTIN_ENV.serverId]: server.id,
    [BUILTIN_ENV.alias]: server.sshAlias,
    [BUILTIN_ENV.name]: server.name,
    [BUILTIN_ENV.runtime]: server.runtime.kind,
    [BUILTIN_ENV.unit]: server.runtime.unit ?? '',
    [BUILTIN_ENV.workdir]: server.runtime.workdir ?? '',
    [BUILTIN_ENV.port]: server.runtime.port === undefined ? '' : String(server.runtime.port),
    [BUILTIN_ENV.composeFile]: server.runtime.composeFile ?? '',
  }
}

/** Build the remote command: optional cd, environment assignments, bash on stdin. */
export function buildRemoteCommand(cwd: string | undefined, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  const prefix = cwd !== undefined && cwd.trim() !== '' ? `cd ${shellQuote(cwd)} && ` : ''
  return `${prefix}env ${assignments} bash -s`
}

/** Remote staging directory for uploaded file parameters. */
export function remoteStagingPath(runId: string, localPath: string): string {
  return `/tmp/dsh-ops/${runId}/${basename(localPath)}`
}

/** Runner knobs (tests inject the webhook transport). */
export interface RunnerOptions {
  fetchImpl?: typeof fetch
  onNotifyError?: (message: string) => void
}

/** The run runner. */
export class TaskRunner {
  private readonly controllers = new Map<string, AbortController>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * @param store - definitions ledger (targets + task definitions).
   * @param runs - run/log store.
   * @param transport - dsh-ssh transport service.
   */
  constructor(
    private readonly store: OpsStore,
    private readonly runs: RunStore,
    private readonly transport: OpsTransport,
    private readonly options: RunnerOptions = {},
  ) {}

  /**
   * Start a run and return its record immediately; execution continues in the
   * background and updates the same record.
   */
  async start(taskId: string, input: Omit<RunInput, 'taskId'> = {}): Promise<OpsRun> {
    return await this.startRun(taskId, input, true)
  }

  /** Start one run; flow children pass notify=false so only the parent notifies. */
  private async startRun(
    taskId: string,
    input: Omit<RunInput, 'taskId'>,
    notify: boolean,
  ): Promise<OpsRun> {
    const definition = this.store.task(taskId)
    if (definition === undefined) throw new Error(`task '${taskId}' not found`)
    if (definition.kind === 'flow') return await this.startFlow(definition, input, notify)
    const plan = planRun(this.store, taskId, input)
    const runId = newRunId()
    const run: OpsRun = {
      id: runId,
      taskId,
      taskName: plan.task.name,
      source: input.source ?? 'ui',
      status: 'running',
      params: { ...plan.params },
      targets: plan.targets.map(server => ({
        serverId: server.id,
        alias: server.sshAlias,
        status: 'pending',
        exitCode: null,
        durationMs: 0,
      })),
      startedAt: Date.now(),
    }
    this.runs.create(run)
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const execution = this.execute(run, plan, input.params ?? {}, controller.signal, notify)
      .catch((error: unknown) => {
        run.status = 'failed'
        run.error = error instanceof Error ? error.message : String(error)
        run.endedAt = Date.now()
        this.runs.update(run)
        if (notify) this.notifyRun(run)
      })
      .finally(() => {
        this.controllers.delete(runId)
        this.pending.delete(runId)
      })
    this.pending.set(runId, execution)
    return structuredClone(run)
  }

  /** Abort a running run; false when it is no longer active. */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** Wait for one run's execution to settle (tests / shutdown). */
  async wait(runId: string): Promise<OpsRun | undefined> {
    await this.pending.get(runId)
    return this.runs.get(runId)
  }

  /** Abort everything (plugin unload). */
  dispose(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  // ------------------------------------------------------------ execution

  /** Run every target serially, persisting the record after each step. */
  private async execute(
    run: OpsRun,
    plan: RunPlan,
    inputParams: Record<string, string>,
    signal: AbortSignal,
    notify: boolean,
  ): Promise<void> {
    for (let index = 0; index < plan.targets.length; index += 1) {
      const server = plan.targets[index]
      const target = run.targets[index]
      if (signal.aborted) {
        target.status = 'cancelled'
        continue
      }
      target.status = 'running'
      this.runs.update(run)
      const started = Date.now()
      try {
        const values = resolveTaskParams(plan.task, inputParams, server)
        const env: Record<string, string> = {
          ...plan.task.env,
          ...(plan.task.serverOverrides?.[server.id]?.env ?? {}),
          ...values,
          ...builtinEnv(server, run.id),
        }
        for (const param of plan.task.params) {
          if (param.type !== 'file') continue
          const local = values[param.name]
          if (local === undefined || local === '') continue
          const remote = remoteStagingPath(run.id, local)
          await this.transport.upload(server.sshAlias, local, remote, false)
          env[param.name] = remote
        }
        const command = buildRemoteCommand(plan.task.cwd, env)
        const result = await this.withLock(server.sshAlias, () => this.transport.execStream(server.sshAlias, command, {
          stdin: plan.task.script,
          timeoutMs: plan.task.timeoutMs,
          signal,
          onStdout: chunk => { this.runs.appendLog(run.id, server.id, chunk) },
          onStderr: chunk => { this.runs.appendLog(run.id, server.id, chunk) },
        }))
        target.exitCode = result.exitCode
        target.error = result.error
        if (signal.aborted) {
          target.status = 'cancelled'
        } else if (result.exitCode === 0 && !result.timedOut && result.error === undefined) {
          target.status = 'ok'
        } else {
          target.status = 'failed'
          if (result.error === undefined && result.timedOut) target.error = 'timed out'
        }
      } catch (error) {
        target.status = signal.aborted ? 'cancelled' : 'failed'
        target.error = error instanceof Error ? error.message : String(error)
      }
      target.durationMs = Date.now() - started
      this.runs.update(run)
    }

    const cancelled = signal.aborted || run.targets.some(target => target.status === 'cancelled')
    const ok = run.targets.filter(target => target.status === 'ok').length
    run.status = cancelled ? 'cancelled' : ok === run.targets.length ? 'ok' : ok === 0 ? 'failed' : 'partial'
    run.endedAt = Date.now()
    this.runs.update(run)
    if (notify) this.notifyRun(run)
  }

  // ---------------------------------------------------------------- flows

  /** Start a flow run: one parent record, one child run per step. */
  private async startFlow(flow: OpsTask, input: Omit<RunInput, 'taskId'>, notify: boolean): Promise<OpsRun> {
    const steps = flow.steps ?? []
    if (steps.length === 0) throw new Error('this flow has no steps yet')
    const runtimeServerIds = input.serverIds === undefined || input.serverIds.length === 0
      ? undefined
      : input.serverIds
    if (runtimeServerIds !== undefined) {
      const reachableIds = new Set<string>()
      for (const step of steps) {
        const task = this.store.task(step.taskId)
        if (task?.kind !== 'script') continue
        for (const server of this.store.targetsOfTask(task)) reachableIds.add(server.id)
      }
      const unknown = runtimeServerIds.filter(id => !reachableIds.has(id))
      if (unknown.length > 0) throw new Error(`server(s) outside this flow's step scopes: ${unknown.join(', ')}`)
    }
    const runId = newRunId()
    const run: OpsRun = {
      id: runId,
      taskId: flow.id,
      taskName: flow.name,
      source: input.source ?? 'ui',
      status: 'running',
      params: { ...(input.params ?? {}) },
      targets: [],
      children: steps.map(step => {
        const task = this.store.task(step.taskId)
        return {
          stepId: step.id,
          taskId: step.taskId,
          taskName: task?.name ?? step.taskId,
          status: 'pending' as const,
        }
      }),
      startedAt: Date.now(),
    }
    this.runs.create(run)
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const execution = this.executeFlow(run, flow, input.params ?? {}, runtimeServerIds, controller.signal, notify)
      .catch((error: unknown) => {
        run.status = 'failed'
        run.error = error instanceof Error ? error.message : String(error)
        run.endedAt = Date.now()
        this.runs.update(run)
        if (notify) this.notifyRun(run)
      })
      .finally(() => {
        this.controllers.delete(runId)
        this.pending.delete(runId)
      })
    this.pending.set(runId, execution)
    return structuredClone(run)
  }

  /** Execute flow batches: serial steps one by one, adjacent parallel steps together. */
  private async executeFlow(
    run: OpsRun,
    flow: OpsTask,
    runtimeParams: Record<string, string>,
    runtimeServerIds: string[] | undefined,
    signal: AbortSignal,
    notify: boolean,
  ): Promise<void> {
    const batches: FlowStep[][] = []
    for (const step of flow.steps ?? []) {
      const last = batches[batches.length - 1]
      if (step.mode === 'parallel' && last !== undefined && last[0]?.mode === 'parallel') last.push(step)
      else batches.push([step])
    }

    let stopped = false
    for (const batch of batches) {
      if (stopped || signal.aborted) {
        for (const step of batch) this.markChild(run, step.id, signal.aborted ? 'cancelled' : 'skipped')
        continue
      }
      const results = batch.length === 1
        ? [await this.runFlowStep(run, batch[0], runtimeParams, runtimeServerIds, signal)]
        : await Promise.all(batch.map(step => this.runFlowStep(run, step, runtimeParams, runtimeServerIds, signal)))
      if (results.some(ok => !ok) && (flow.failure ?? 'stop') === 'stop') stopped = true
    }

    const children = run.children ?? []
    const cancelled = signal.aborted || children.some(child => child.status === 'cancelled')
    const skipped = children.some(child => child.status === 'skipped')
    const ok = children.filter(child => child.status === 'ok').length
    // A stop-policy chain that never reached its remaining steps is a failure,
    // not a partial result; partial means every step ran with mixed outcomes.
    run.status = cancelled ? 'cancelled' : ok === children.length ? 'ok' : skipped || ok === 0 ? 'failed' : 'partial'
    run.endedAt = Date.now()
    this.runs.update(run)
    this.runs.appendLog(run.id, 'flow', `flow ${run.status}: ${ok}/${children.length} steps ok\n`)
    if (notify) this.notifyRun(run)
  }

  /** Run one step's referenced task and mirror its child run status. */
  private async runFlowStep(
    run: OpsRun,
    step: FlowStep,
    runtimeParams: Record<string, string>,
    runtimeServerIds: string[] | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const child = run.children?.find(entry => entry.stepId === step.id)
    if (child === undefined) return true
    if (signal.aborted) {
      child.status = 'cancelled'
      this.runs.update(run)
      return false
    }
    child.status = 'running'
    child.startedAt = Date.now()
    this.runs.update(run)

    const task = this.store.task(step.taskId)
    if (task === undefined || task.kind !== 'script') {
      child.status = 'failed'
      child.endedAt = Date.now()
      this.runs.appendLog(run.id, 'flow', `[${child.taskName}] referenced task is missing or not a script\n`)
      this.runs.update(run)
      return false
    }

    try {
      const runtimeIds = runtimeServerIds === undefined ? undefined : new Set(runtimeServerIds)
      const stepIds = step.serverIds === undefined ? undefined : new Set(step.serverIds)
      const targets = this.store.targetsOfTask(task).filter(server =>
        (runtimeIds === undefined || runtimeIds.has(server.id))
        && (stepIds === undefined || stepIds.has(server.id)))
      if (targets.length === 0) {
        throw new Error('no target servers remain after applying the flow and step scopes')
      }
      const started = await this.startRun(task.id, {
        params: { ...(step.params ?? {}), ...runtimeParams },
        source: run.source,
        serverIds: targets.map(server => server.id),
      }, false)
      child.runId = started.id
      this.runs.update(run)
      const onAbort = (): void => { this.cancel(started.id) }
      signal.addEventListener('abort', onAbort, { once: true })
      const finished = await this.wait(started.id)
      signal.removeEventListener('abort', onAbort)
      child.status = finished?.status === 'ok'
        ? 'ok'
        : finished?.status === 'cancelled' ? 'cancelled' : 'failed'
      child.endedAt = Date.now()
      this.runs.appendLog(run.id, 'flow', `[${child.taskName}] ${child.status} (${started.id})\n`)
      this.runs.update(run)
      return child.status === 'ok'
    } catch (error) {
      child.status = 'failed'
      child.endedAt = Date.now()
      this.runs.appendLog(run.id, 'flow', `[${child.taskName}] failed: ${error instanceof Error ? error.message : String(error)}\n`)
      this.runs.update(run)
      return false
    }
  }

  /** Mark one pending step child's state. */
  private markChild(run: OpsRun, stepId: string, status: 'cancelled' | 'skipped'): void {
    const child = run.children?.find(entry => entry.stepId === stepId)
    if (child === undefined) return
    child.status = status
    child.endedAt = Date.now()
    this.runs.update(run)
  }

  /** POST the finished run to the configured webhook (best effort). */
  private notifyRun(run: OpsRun): void {
    const settings = this.store.settings()
    void sendRunWebhook(settings, run, this.options.fetchImpl)
      .then((result) => {
        if (!result.sent && result.error !== undefined) {
          (this.options.onNotifyError ?? ((message: string) => { console.warn('[dsh-ops] webhook failed:', message) }))(result.error)
        }
      })
      .catch((error: unknown) => {
        (this.options.onNotifyError ?? ((message: string) => { console.warn('[dsh-ops] webhook failed:', message) }))(
          error instanceof Error ? error.message : String(error),
        )
      })
  }

  /** Serialize operations per SSH alias (two runs never touch one server at once). */
  private async withLock<T>(alias: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(alias) ?? Promise.resolve()
    const gate = previous.then(fn, fn)
    this.locks.set(alias, gate.then(() => undefined, () => undefined))
    return gate
  }
}
