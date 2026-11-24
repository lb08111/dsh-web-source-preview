/**
 * Definitions ledger: one JSON file (`$DSH_HOME/ops/definitions.json`) holding
 * the whole tree — systems, services, servers and shared task definitions.
 *
 * Pure file I/O with the family's storage discipline: atomic tmp+rename writes
 * (0600, owner only), a schema version, a monotonic revision, an mtime-keyed
 * read cache, and a corrupt file renamed aside instead of being overwritten.
 *
 * Runtime state (run records and logs) does NOT live here: it is written by
 * runner.ts under the same directory so a busy runner never rewrites the
 * definitions file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isValidCron, isValidTimeZone } from './schedule.ts'
import { dshHome } from './dsh-home.ts'
import type {
  FlowFailure,
  FlowStep,
  OpsSettings,
  OpsServer,
  OpsService,
  OpsSystem,
  OpsTask,
  RuntimeKind,
  ServerInput,
  ServerTaskOverride,
  ServiceInput,
  SystemInput,
  TaskInput,
  TaskParam,
  TaskRisk,
  TaskSchedule,
  TreeSnapshot,
} from './protocol.ts'

/** File format version. */
const FORMAT_VERSION = 1

/** Name cap shared by every node. */
const MAX_NAME = 80

/** Task timeout bounds (ms). */
const MIN_TIMEOUT = 1_000
const MAX_TIMEOUT = 3_600_000

/** Directory holding the ops ledger, runs and logs. */
export function opsDir(): string {
  return join(dshHome(), 'ops')
}

/** Store file location. */
export function definitionsPath(): string {
  return join(opsDir(), 'definitions.json')
}

interface DefinitionsFile {
  version: number
  revision: number
  systems: OpsSystem[]
  services: OpsService[]
  servers: OpsServer[]
  tasks: OpsTask[]
  settings?: OpsSettings
}

/** One stored server as the store accepts it (the host already exists). */
export interface ServerRecordInput {
  serviceId: string
  sshAlias: string
  name?: string
  environment?: string
  runtime: ServerInput['runtime']
  color?: string
}

/** Optional #rrggbb accent; an empty value clears it. */
export function normalizeColor(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a #rrggbb color`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) throw new Error(`${field} must be a #rrggbb color`)
  return trimmed.toLowerCase()
}

/** New id for one node kind (short, readable, collision-safe enough). */
function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

/** Trimmed non-empty name or a refusal. */
function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required')
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME) throw new Error(`name must be at most ${MAX_NAME} characters`)
  return trimmed
}

/** Optional trimmed text (empty becomes undefined). */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** One env-var-shaped parameter name. */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Normalize and validate one parameter definition. */
export function normalizeParam(raw: unknown, index: number): TaskParam {
  if (typeof raw !== 'object' || raw === null) throw new Error(`params[${index}] must be an object`)
  const p = raw as Record<string, unknown>
  if (typeof p.name !== 'string' || !PARAM_NAME_RE.test(p.name)) {
    throw new Error(`params[${index}].name must be an env-var name (letters, digits, underscore)`)
  }
  const type = p.type
  if (type !== 'text' && type !== 'number' && type !== 'boolean' && type !== 'select' && type !== 'file') {
    throw new Error(`params[${index}].type must be text, number, boolean, select or file`)
  }
  const options = Array.isArray(p.options)
    ? p.options.filter((option): option is string => typeof option === 'string')
    : undefined
  if (type === 'select' && (options === undefined || options.length === 0)) {
    throw new Error(`params[${index}].options is required for a select parameter`)
  }
  return {
    name: p.name,
    label: optionalText(p.label, `params[${index}].label`),
    type,
    required: p.required === true,
    default: p.default === undefined || p.default === null ? undefined : String(p.default),
    options,
    description: optionalText(p.description, `params[${index}].description`),
  }
}

/** Normalize a full parameter list (duplicate names refused). */
export function normalizeParams(raw: unknown): TaskParam[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('params must be an array')
  const params = raw.map((param, index) => normalizeParam(param, index))
  const seen = new Set<string>()
  for (const param of params) {
    if (seen.has(param.name)) throw new Error(`duplicate parameter '${param.name}'`)
    seen.add(param.name)
  }
  return params
}

/** Normalize an environment map (string values only). */
export function normalizeEnv(raw: unknown, field: string): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${field} must be an object`)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(key)) throw new Error(`${field}.${key} must be an env-var name`)
    if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string`)
    env[key] = value
  }
  return env
}

/** Normalize per-server overrides. */
function normalizeOverrides(raw: unknown): Record<string, ServerTaskOverride> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('serverOverrides must be an object')
  const overrides: Record<string, ServerTaskOverride> = {}
  for (const [serverId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) throw new Error(`serverOverrides.${serverId} must be an object`)
    const entry = value as Record<string, unknown>
    overrides[serverId] = {
      params: normalizeEnv(entry.params, `serverOverrides.${serverId}.params`),
      env: normalizeEnv(entry.env, `serverOverrides.${serverId}.env`),
    }
  }
  return overrides
}

/** Runtime kinds the store accepts. */
const RUNTIME_KINDS: RuntimeKind[] = ['systemd', 'compose', 'docker', 'supervisor', 'custom']

/** Normalize one runtime spec. */
export function normalizeRuntime(raw: unknown): ServerInput['runtime'] {
  if (typeof raw !== 'object' || raw === null) throw new Error('runtime is required')
  const r = raw as Record<string, unknown>
  if (typeof r.kind !== 'string' || !RUNTIME_KINDS.includes(r.kind as RuntimeKind)) {
    throw new Error('runtime.kind must be systemd, compose, docker, supervisor or custom')
  }
  const port = r.port === undefined ? undefined : Number(r.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('runtime.port must be an integer in 1..65535')
  }
  return {
    kind: r.kind as RuntimeKind,
    unit: optionalText(r.unit, 'runtime.unit'),
    workdir: optionalText(r.workdir, 'runtime.workdir'),
    port,
    composeFile: optionalText(r.composeFile, 'runtime.composeFile'),
  }
}

/**
 * The definitions ledger. Pure file I/O — no cordis dependency, unit-testable.
 */
export class OpsStore {
  /** The JSON file path. */
  readonly path: string

  /**
   * @param path - store file path (defaults to the standard location).
   */
  constructor(path?: string) {
    this.path = path ?? definitionsPath()
  }

  // ------------------------------------------------------------ read

  /** Full definitions snapshot for the browser tree. */
  snapshot(): TreeSnapshot {
    const file = this.load()
    return {
      revision: file.revision,
      systems: file.systems.map(entry => ({ ...entry })),
      services: file.services.map(entry => ({ ...entry })),
      servers: file.servers.map(entry => ({ ...entry, runtime: { ...entry.runtime } })),
      tasks: file.tasks.map(entry => this.copyTask(entry)),
    }
  }

  /** All systems. */
  systems(): OpsSystem[] {
    return this.load().systems.map(entry => ({ ...entry }))
  }

  /** All services. */
  services(): OpsService[] {
    return this.load().services.map(entry => ({ ...entry }))
  }

  /** All servers. */
  servers(): OpsServer[] {
    return this.load().servers.map(entry => ({ ...entry, runtime: { ...entry.runtime } }))
  }

  /** All tasks. */
  tasks(): OpsTask[] {
    return this.load().tasks.map(entry => this.copyTask(entry))
  }

  /** One system by id. */
  system(id: string): OpsSystem | undefined {
    const entry = this.load().systems.find(candidate => candidate.id === id)
    return entry === undefined ? undefined : { ...entry }
  }

  /** One service by id. */
  service(id: string): OpsService | undefined {
    const entry = this.load().services.find(candidate => candidate.id === id)
    return entry === undefined ? undefined : { ...entry }
  }

  /** One server by id. */
  server(id: string): OpsServer | undefined {
    const entry = this.load().servers.find(candidate => candidate.id === id)
    return entry === undefined ? undefined : { ...entry, runtime: { ...entry.runtime } }
  }

  /** One task by id. */
  task(id: string): OpsTask | undefined {
    const entry = this.load().tasks.find(candidate => candidate.id === id)
    return entry === undefined ? undefined : this.copyTask(entry)
  }

  /** Current revision. */
  revision(): number {
    return this.load().revision
  }

  /** Servers belonging to one service. */
  serversOfService(serviceId: string): OpsServer[] {
    return this.load().servers
      .filter(entry => entry.serviceId === serviceId)
      .map(entry => ({ ...entry, runtime: { ...entry.runtime } }))
  }

  /** Services belonging to one system. */
  servicesOfSystem(systemId: string): OpsService[] {
    return this.load().services
      .filter(entry => entry.systemId === systemId)
      .map(entry => ({ ...entry }))
  }

  /** Tasks defined on one owner. */
  tasksOfOwner(kind: 'service' | 'system', id: string): OpsTask[] {
    return this.load().tasks
      .filter(entry => entry.owner.kind === kind && entry.owner.id === id)
      .map(entry => this.copyTask(entry))
  }

  /**
   * Resolve a task's default target servers from its owner and scope.
   * @param task - the stored task.
   * @returns the servers the task applies to (empty when a single-server task
   *   points at a removed server).
   */
  targetsOfTask(task: OpsTask): OpsServer[] {
    // A flow has no targets of its own: every step resolves its own task.
    if (task.kind === 'flow') return []
    if (task.scope === 'single') {
      const server = this.server(task.serverId ?? '')
      return server === undefined ? [] : [server]
    }
    if (task.owner.kind === 'service') return this.serversOfService(task.owner.id)
    const serviceIds = new Set(this.servicesOfSystem(task.owner.id).map(service => service.id))
    return this.load().servers
      .filter(entry => serviceIds.has(entry.serviceId))
      .map(entry => ({ ...entry, runtime: { ...entry.runtime } }))
  }

  // ------------------------------------------------------------ systems

  /** Create one system. */
  createSystem(input: SystemInput): OpsSystem {
    const file = this.load()
    const now = Date.now()
    const entry: OpsSystem = {
      id: newId('sys'),
      name: requireName(input.name),
      description: optionalText(input.description, 'description'),
      ...(normalizeColor(input.color, 'color') === undefined ? {} : { color: normalizeColor(input.color, 'color') }),
      createdAt: now,
      updatedAt: now,
    }
    file.systems.push(entry)
    this.commit(file)
    return { ...entry }
  }

  /** Update a system's name/description. */
  updateSystem(id: string, patch: Partial<SystemInput>): OpsSystem {
    const file = this.load()
    const entry = file.systems.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`system '${id}' not found`)
    if (patch.name !== undefined) entry.name = requireName(patch.name)
    if (patch.description !== undefined) entry.description = optionalText(patch.description, 'description')
    if (patch.color !== undefined) entry.color = normalizeColor(patch.color, 'color')
    entry.updatedAt = Date.now()
    this.commit(file)
    return { ...entry }
  }

  /** Delete a system and everything under it. */
  deleteSystem(id: string): void {
    const file = this.load()
    if (!file.systems.some(entry => entry.id === id)) throw new Error(`system '${id}' not found`)
    const serviceIds = new Set(file.services.filter(service => service.systemId === id).map(service => service.id))
    file.systems = file.systems.filter(entry => entry.id !== id)
    file.services = file.services.filter(entry => entry.systemId !== id)
    file.servers = file.servers.filter(entry => !serviceIds.has(entry.serviceId))
    file.tasks = file.tasks.filter(task =>
      !(task.owner.kind === 'system' && task.owner.id === id)
      && !(task.owner.kind === 'service' && serviceIds.has(task.owner.id)))
    this.commit(file)
  }

  // ------------------------------------------------------------ services

  /** Create one service under a system. */
  createService(input: ServiceInput): OpsService {
    const file = this.load()
    if (!file.systems.some(entry => entry.id === input.systemId)) throw new Error(`system '${input.systemId}' not found`)
    const now = Date.now()
    const entry: OpsService = {
      id: newId('svc'),
      systemId: input.systemId,
      name: requireName(input.name),
      description: optionalText(input.description, 'description'),
      ...(normalizeColor(input.color, 'color') === undefined ? {} : { color: normalizeColor(input.color, 'color') }),
      createdAt: now,
      updatedAt: now,
    }
    file.services.push(entry)
    this.commit(file)
    return { ...entry }
  }

  /** Update a service's name/description. */
  updateService(id: string, patch: Partial<Omit<ServiceInput, 'systemId'>>): OpsService {
    const file = this.load()
    const entry = file.services.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`service '${id}' not found`)
    if (patch.name !== undefined) entry.name = requireName(patch.name)
    if (patch.description !== undefined) entry.description = optionalText(patch.description, 'description')
    if (patch.color !== undefined) entry.color = normalizeColor(patch.color, 'color')
    entry.updatedAt = Date.now()
    this.commit(file)
    return { ...entry }
  }

  /** Delete a service, its servers and the tasks defined on it. */
  deleteService(id: string): void {
    const file = this.load()
    if (!file.services.some(entry => entry.id === id)) throw new Error(`service '${id}' not found`)
    const serverIds = new Set(file.servers.filter(server => server.serviceId === id).map(server => server.id))
    file.services = file.services.filter(entry => entry.id !== id)
    file.servers = file.servers.filter(entry => entry.serviceId !== id)
    file.tasks = file.tasks.filter(task => !(task.owner.kind === 'service' && task.owner.id === id))
    // Drop overrides that referenced the removed servers.
    for (const task of file.tasks) {
      if (task.serverOverrides === undefined) continue
      for (const serverId of serverIds) delete task.serverOverrides[serverId]
    }
    this.commit(file)
  }

  // ------------------------------------------------------------ servers

  /** Register one server (its SSH host must already exist). */
  createServer(input: ServerRecordInput): OpsServer {
    const file = this.load()
    const service = file.services.find(entry => entry.id === input.serviceId)
    if (service === undefined) throw new Error(`service '${input.serviceId}' not found`)
    const alias = optionalText(input.sshAlias, 'sshAlias')
    if (alias === undefined) throw new Error('sshAlias is required')
    if (file.servers.some(entry => entry.serviceId === input.serviceId && entry.sshAlias === alias)) {
      throw new Error(`server '${alias}' is already attached to this service`)
    }
    const now = Date.now()
    const entry: OpsServer = {
      id: newId('srv'),
      serviceId: input.serviceId,
      sshAlias: alias,
      name: optionalText(input.name, 'name') ?? alias,
      environment: optionalText(input.environment, 'environment'),
      runtime: normalizeRuntime(input.runtime),
      ...(normalizeColor(input.color, 'color') === undefined ? {} : { color: normalizeColor(input.color, 'color') }),
      createdAt: now,
      updatedAt: now,
    }
    file.servers.push(entry)
    this.commit(file)
    return { ...entry, runtime: { ...entry.runtime } }
  }

  /** Update a server's display fields/runtime. */
  updateServer(id: string, patch: Partial<Omit<ServerRecordInput, 'serviceId'>>): OpsServer {
    const file = this.load()
    const entry = file.servers.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`server '${id}' not found`)
    if (patch.sshAlias !== undefined) {
      const alias = optionalText(patch.sshAlias, 'sshAlias')
      if (alias === undefined) throw new Error('sshAlias cannot be empty')
      entry.sshAlias = alias
    }
    if (patch.name !== undefined) entry.name = optionalText(patch.name, 'name') ?? entry.sshAlias
    if (patch.environment !== undefined) entry.environment = optionalText(patch.environment, 'environment')
    if (patch.runtime !== undefined) entry.runtime = normalizeRuntime(patch.runtime)
    if (patch.color !== undefined) entry.color = normalizeColor(patch.color, 'color')
    entry.updatedAt = Date.now()
    this.commit(file)
    return { ...entry, runtime: { ...entry.runtime } }
  }

  /** Detach a server and drop overrides that pointed at it. */
  deleteServer(id: string): void {
    const file = this.load()
    if (!file.servers.some(entry => entry.id === id)) throw new Error(`server '${id}' not found`)
    file.servers = file.servers.filter(entry => entry.id !== id)
    for (const task of file.tasks) {
      if (task.serverOverrides !== undefined) delete task.serverOverrides[id]
      if (task.scope === 'single' && task.serverId === id) {
        // A single-server task loses its target: keep the definition but leave
        // it without a server so the browser can ask where it belongs.
        task.serverId = undefined
      }
    }
    this.commit(file)
  }

  // ------------------------------------------------------------ tasks

  /** Create one task definition (script or flow). */
  createTask(input: TaskInput): OpsTask {
    const file = this.load()
    this.assertOwner(file, input.owner)
    const now = Date.now()
    const kind = input.kind === 'flow' ? 'flow' : 'script'
    const entry: OpsTask = {
      id: newId('task'),
      owner: { ...input.owner },
      name: requireName(input.name),
      description: optionalText(input.description, 'description'),
      kind,
      script: kind === 'script' ? requireScript(input.script) : (typeof input.script === 'string' ? input.script : ''),
      shell: 'bash',
      params: kind === 'script' ? normalizeParams(input.params) : [],
      env: kind === 'script' ? normalizeEnv(input.env, 'env') : {},
      cwd: optionalText(input.cwd, 'cwd'),
      timeoutMs: normalizeTimeout(input.timeoutMs),
      risk: normalizeRisk(input.risk),
      scope: input.scope === 'single' ? 'single' : 'all',
      serverId: optionalText(input.serverId, 'serverId'),
      serverOverrides: kind === 'script' ? normalizeOverrides(input.serverOverrides) : undefined,
      ...(kind === 'flow' ? { steps: normalizeSteps(input.steps), failure: normalizeFailure(input.failure) } : {}),
      ...(input.schedule === undefined ? {} : { schedule: normalizeSchedule(input.schedule) }),
      createdAt: now,
      updatedAt: now,
    }
    this.assertScope(file, entry)
    this.assertTaskShape(file, entry)
    file.tasks.push(entry)
    this.commit(file)
    return this.copyTask(entry)
  }

  /** Update a task definition (fields present in `patch`). */
  updateTask(id: string, patch: Partial<TaskInput>): OpsTask {
    const file = this.load()
    const entry = file.tasks.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`task '${id}' not found`)
    if (patch.owner !== undefined) {
      this.assertOwner(file, patch.owner)
      entry.owner = { ...patch.owner }
    }
    if (patch.name !== undefined) entry.name = requireName(patch.name)
    if (patch.description !== undefined) entry.description = optionalText(patch.description, 'description')
    if (patch.kind !== undefined) {
      const kind = patch.kind === 'flow' ? 'flow' : 'script'
      if (kind !== entry.kind) {
        entry.kind = kind
        if (kind === 'flow') {
          entry.steps = entry.steps ?? []
          entry.failure = entry.failure ?? 'stop'
          entry.script = ''
          entry.params = []
          entry.env = {}
          entry.serverOverrides = undefined
        } else {
          entry.steps = undefined
          entry.failure = undefined
        }
      }
    }
    if (patch.steps !== undefined) entry.steps = normalizeSteps(patch.steps)
    if (patch.failure !== undefined) entry.failure = normalizeFailure(patch.failure)
    if (patch.script !== undefined) {
      entry.script = entry.kind === 'flow' ? (typeof patch.script === 'string' ? patch.script : '') : requireScript(patch.script)
    }
    if (patch.params !== undefined) entry.params = normalizeParams(patch.params)
    if (patch.env !== undefined) entry.env = normalizeEnv(patch.env, 'env')
    if (patch.cwd !== undefined) entry.cwd = optionalText(patch.cwd, 'cwd')
    if (patch.timeoutMs !== undefined) entry.timeoutMs = normalizeTimeout(patch.timeoutMs)
    if (patch.risk !== undefined) entry.risk = normalizeRisk(patch.risk)
    if (patch.scope !== undefined) entry.scope = patch.scope === 'single' ? 'single' : 'all'
    if (patch.serverId !== undefined) entry.serverId = optionalText(patch.serverId, 'serverId')
    if (patch.serverOverrides !== undefined) entry.serverOverrides = normalizeOverrides(patch.serverOverrides)
    if (patch.schedule !== undefined) entry.schedule = normalizeSchedule(patch.schedule)
    this.assertScope(file, entry)
    this.assertTaskShape(file, entry)
    entry.updatedAt = Date.now()
    this.commit(file)
    return this.copyTask(entry)
  }

  /** Delete one task; a task used by a flow is refused. */
  deleteTask(id: string): void {
    const file = this.load()
    if (!file.tasks.some(entry => entry.id === id)) throw new Error(`task '${id}' not found`)
    const flow = file.tasks.find(entry => (entry.kind === 'flow')
      && (entry.steps ?? []).some(step => step.taskId === id))
    if (flow !== undefined) throw new Error(`task is used by flow '${flow.name}'; remove that step first`)
    file.tasks = file.tasks.filter(entry => entry.id !== id)
    this.commit(file)
  }

  /** Workspace notification settings. */
  settings(): OpsSettings {
    const raw = this.load().settings
    return {
      webhookOn: raw?.webhookOn === 'always' ? 'always' : 'failure',
      ...(typeof raw?.webhookUrl === 'string' && raw.webhookUrl.trim() !== ''
        ? { webhookUrl: raw.webhookUrl.trim() }
        : {}),
    }
  }

  /** Update notification settings. */
  updateSettings(patch: Partial<OpsSettings>): OpsSettings {
    const file = this.load()
    const current = this.settings()
    const webhookUrl = patch.webhookUrl === undefined ? current.webhookUrl : patch.webhookUrl.trim()
    if (webhookUrl !== undefined && webhookUrl !== '' && !/^https?:\/\//i.test(webhookUrl)) {
      throw new Error('webhookUrl must be an http(s) URL')
    }
    file.settings = {
      ...(webhookUrl === undefined || webhookUrl === '' ? {} : { webhookUrl }),
      webhookOn: (patch.webhookOn ?? current.webhookOn) === 'always' ? 'always' : 'failure',
    }
    this.commit(file)
    return this.settings()
  }

  /** Record the last cron trigger of one task (scheduler bookkeeping). */
  markScheduleRun(taskId: string, at: number): void {
    const file = this.load()
    const task = file.tasks.find(entry => entry.id === taskId)
    if (task === undefined || task.schedule === undefined) return
    task.schedule.lastRunAt = at
    task.updatedAt = at
    this.commit(file)
  }

  // ------------------------------------------------------------ internals

  /** Deep-enough copy of one task. */
  private copyTask(entry: OpsTask): OpsTask {
    const kind = entry.kind === 'flow' ? 'flow' : 'script'
    return {
      ...entry,
      kind,
      owner: { ...entry.owner },
      params: entry.params.map(param => ({ ...param, options: param.options === undefined ? undefined : [...param.options] })),
      env: { ...entry.env },
      serverOverrides: entry.serverOverrides === undefined
        ? undefined
        : Object.fromEntries(Object.entries(entry.serverOverrides).map(([serverId, override]) => [
            serverId,
            { params: { ...override.params }, env: { ...override.env } },
          ])),
      ...(kind === 'flow'
        ? {
            steps: (entry.steps ?? []).map(step => ({ ...step })),
            failure: entry.failure ?? 'stop',
          }
        : {}),
      ...(entry.schedule === undefined ? {} : { schedule: { ...entry.schedule } }),
    }
  }

  /** Owner must exist; a service belongs to a system. */
  private assertOwner(file: DefinitionsFile, owner: TaskInput['owner']): void {
    if (owner.kind === 'system') {
      if (!file.systems.some(entry => entry.id === owner.id)) throw new Error(`system '${owner.id}' not found`)
      return
    }
    if (owner.kind === 'service') {
      if (!file.services.some(entry => entry.id === owner.id)) throw new Error(`service '${owner.id}' not found`)
      return
    }
    throw new Error("owner.kind must be 'service' or 'system'")
  }

  /** Single-server scope must point at a server of the owning service. */
  private assertScope(file: DefinitionsFile, task: OpsTask): void {
    if (task.scope !== 'single') return
    if (task.serverId === undefined || task.serverId === '') {
      throw new Error('serverId is required when scope is single')
    }
    const server = file.servers.find(entry => entry.id === task.serverId)
    if (server === undefined) throw new Error(`server '${task.serverId}' not found`)
    if (task.owner.kind === 'service' && server.serviceId !== task.owner.id) {
      throw new Error('a single-server task must target a server of its owning service')
    }
    if (task.owner.kind === 'system') {
      const service = file.services.find(entry => entry.id === server.serviceId)
      if (service === undefined || service.systemId !== task.owner.id) {
        throw new Error('a single-server task must target a server inside its owning system')
      }
    }
  }

  /** A script needs source; a flow's steps must reference script tasks. */
  private assertTaskShape(file: DefinitionsFile, task: OpsTask): void {
    if (task.kind !== 'flow') {
      if (task.script.trim() === '') throw new Error('script is required')
      return
    }
    for (const [index, step] of (task.steps ?? []).entries()) {
      const target = file.tasks.find(entry => entry.id === step.taskId)
      if (target === undefined) throw new Error(`steps[${index}] references unknown task '${step.taskId}'`)
      if (target.kind === 'flow') throw new Error(`steps[${index}] must reference a script task, not a flow`)
      if (target.id === task.id) throw new Error(`steps[${index}] must not reference its own flow`)
    }
  }

  /** Last parsed store keyed by file identity. */
  private cache: { mtimeMs: number; size: number; file: DefinitionsFile } | undefined

  /** Load the file (empty store when absent; corrupt file renamed aside). */
  private load(): DefinitionsFile {
    let stats: { mtimeMs: number; size: number }
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, revision: 0, systems: [], services: [], servers: [], tasks: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as DefinitionsFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.systems)) {
        throw new Error('store file shape invalid')
      }
      if (!Array.isArray(parsed.services) || !Array.isArray(parsed.servers) || !Array.isArray(parsed.tasks)) {
        throw new Error('store file shape invalid')
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      this.cache = undefined
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return { version: FORMAT_VERSION, revision: 0, systems: [], services: [], servers: [], tasks: [] }
    }
  }

  /** Persist one mutation and bump the revision. */
  private commit(file: DefinitionsFile): void {
    file.version = FORMAT_VERSION
    file.revision += 1
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = undefined
  }
}

/** Normalize one task schedule (cron validated, zone checked). */
export function normalizeSchedule(raw: unknown): TaskSchedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('schedule must be an object')
  const value = raw as Record<string, unknown>
  const cron = typeof value.cron === 'string' ? value.cron.trim() : ''
  if (cron === '') throw new Error('schedule.cron is required')
  if (!isValidCron(cron)) throw new Error(`invalid cron expression '${cron}'`)
  const timeZone = optionalText(value.timeZone, 'schedule.timeZone')
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) throw new Error(`unknown time zone '${timeZone}'`)
  const lastRunAt = typeof value.lastRunAt === 'number' && Number.isFinite(value.lastRunAt) ? value.lastRunAt : undefined
  return {
    enabled: value.enabled !== false,
    cron,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  }
}

/** Normalize a flow's step list (missing/duplicate ids are regenerated). */
export function normalizeSteps(raw: unknown): FlowStep[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('steps must be an array')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`steps[${index}] must be an object`)
    const step = item as Record<string, unknown>
    if (typeof step.taskId !== 'string' || step.taskId.trim() === '') {
      throw new Error(`steps[${index}].taskId is required`)
    }
    let id = typeof step.id === 'string' ? step.id.trim() : ''
    if (id === '' || seen.has(id)) id = newId('step')
    seen.add(id)
    const params = (typeof step.params === 'object' && step.params !== null && !Array.isArray(step.params))
      ? Object.fromEntries(Object.entries(step.params as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined
    const serverIds = Array.isArray(step.serverIds)
      ? step.serverIds.filter((value): value is string => typeof value === 'string')
      : undefined
    return {
      id,
      taskId: step.taskId.trim(),
      mode: step.mode === 'parallel' ? 'parallel' : 'serial',
      ...(params === undefined || Object.keys(params).length === 0 ? {} : { params }),
      ...(serverIds === undefined || serverIds.length === 0 ? {} : { serverIds }),
    }
  })
}

/** Flow failure policy (default stop). */
function normalizeFailure(raw: unknown): FlowFailure {
  if (raw === undefined || raw === null) return 'stop'
  if (raw !== 'stop' && raw !== 'continue') throw new Error("failure must be 'stop' or 'continue'")
  return raw
}

/** Non-empty script or a refusal. */
function requireScript(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('script is required')
  return raw
}

/** Timeout within the accepted bounds (default 120s). */
function normalizeTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return 120_000
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error('timeoutMs must be an integer')
  }
  if (raw < MIN_TIMEOUT || raw > MAX_TIMEOUT) {
    throw new Error(`timeoutMs must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}`)
  }
  return raw
}

/** Risk classification (default write). */
function normalizeRisk(raw: unknown): TaskRisk {
  if (raw === undefined || raw === null) return 'write'
  if (raw !== 'read' && raw !== 'write' && raw !== 'destructive') {
    throw new Error('risk must be read, write or destructive')
  }
  return raw
}
