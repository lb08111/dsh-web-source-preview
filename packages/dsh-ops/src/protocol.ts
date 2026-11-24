/**
 * Wire contract between the ops host half (store.ts / runner.ts / routes.ts)
 * and the browser half (client/api.ts). Pure types only — imported by both
 * halves, bundled into each, no runtime identity to share.
 */

/** Route paths the client calls (shared literals). */
export const OPS_API_BASE = '/api/dsh-ops' as const

export const OPS_API = {
  tree: OPS_API_BASE + '/tree',
  systems: OPS_API_BASE + '/systems',
  services: OPS_API_BASE + '/services',
  servers: OPS_API_BASE + '/servers',
  repo: OPS_API_BASE + '/repo',
  repoTest: OPS_API_BASE + '/repo/test',
  repoImportCsv: OPS_API_BASE + '/repo/import-csv',
  repoImportSshConfig: OPS_API_BASE + '/repo/import-ssh-config',
  tasks: OPS_API_BASE + '/tasks',
  runs: OPS_API_BASE + '/runs',
  runDetail: OPS_API_BASE + '/runs/detail',
  runLog: OPS_API_BASE + '/runs/log',
  runCancel: OPS_API_BASE + '/runs/cancel',
  settings: OPS_API_BASE + '/settings',
  panelCommands: OPS_API_BASE + '/panel/commands',
} as const

/** Deployment runtimes a server may declare. */
export type RuntimeKind = 'systemd' | 'compose' | 'docker' | 'supervisor' | 'custom'

/** How one server's application is supervised. */
export interface RuntimeSpec {
  kind: RuntimeKind
  /** systemd unit / supervisor program / docker container name. */
  unit?: string
  /** Application root, used by templates that switch a `current` symlink. */
  workdir?: string
  /** Service port, used by health checks and built-in variables. */
  port?: number
  /** compose file path (compose runtime). */
  composeFile?: string
}

/** One system (the top of the tree). */
export interface OpsSystem {
  id: string
  name: string
  description?: string
  /** Card accent (#rrggbb). */
  color?: string
  createdAt: number
  updatedAt: number
}

/** One service inside a system. */
export interface OpsService {
  id: string
  systemId: string
  name: string
  description?: string
  /** Card accent (#rrggbb); falls back to the owning system. */
  color?: string
  createdAt: number
  updatedAt: number
}

/** One server: a service's deployment on a machine (SSH alias reference). */
export interface OpsServer {
  id: string
  serviceId: string
  /** Alias in the dsh-ssh host store (the server repository). */
  sshAlias: string
  /** Display name (defaults to the alias). */
  name: string
  /** Logical group shown in the repository picker. */
  environment?: string
  runtime: RuntimeSpec
  /** Card accent (#rrggbb); falls back to the owning service. */
  color?: string
  createdAt: number
  updatedAt: number
}

/** Task parameter types. */
export type TaskParamType = 'text' | 'number' | 'boolean' | 'select' | 'file'

/** One parameter a task exposes before a run. */
export interface TaskParam {
  /** Env-var name the script reads (uppercase by convention). */
  name: string
  label?: string
  type: TaskParamType
  required?: boolean
  default?: string
  options?: string[]
  description?: string
}

/** Task risk classification (drives confirmation and agent exposure). */
export type TaskRisk = 'read' | 'write' | 'destructive'

/** Where a task is defined and what it targets by default. */
export interface TaskOwner {
  kind: 'service' | 'system'
  id: string
}

/** Per-server overrides for an otherwise shared task definition. */
export interface ServerTaskOverride {
  params?: Record<string, string>
  env?: Record<string, string>
}

/** What a task is: one script, or an ordered chain of script tasks. */
export type TaskKind = 'script' | 'flow'

/** How one flow step runs relative to its neighbours. */
export type FlowStepMode = 'serial' | 'parallel'

/** One step of a flow: a reference to a script task. */
export interface FlowStep {
  id: string
  /** Referenced task id (script tasks only in this milestone). */
  taskId: string
  /** serial (default) or parallel with the neighbouring parallel steps. */
  mode: FlowStepMode
  /** Values passed to the referenced task (defaults < these < run input). */
  params?: Record<string, string>
  /** Restrict this step to a subset of the task's targets. */
  serverIds?: string[]
}

/** A step as callers provide it (ids are generated when omitted). */
export interface FlowStepInput {
  id?: string
  taskId: string
  mode?: FlowStepMode
  params?: Record<string, string>
  serverIds?: string[]
}

/** What to do when a flow step fails. */
export type FlowFailure = 'stop' | 'continue'

/** One task's cron schedule (host-side scheduler). */
export interface TaskSchedule {
  enabled: boolean
  /** Five-field cron: minute hour day-of-month month weekday. */
  cron: string
  /** IANA zone; omitted means the host zone. */
  timeZone?: string
  /** Last cron trigger (ms since epoch). */
  lastRunAt?: number
}

/** Node kinds the browser panel can be told to show. */
export type PanelNodeKind = 'root' | 'system' | 'service' | 'server' | 'task' | 'run'

/** One browser-panel command (host tool -> browser). */
export interface PanelCommand {
  seq: number
  action: 'open' | 'select' | 'refresh'
  node?: { kind: PanelNodeKind; id?: string }
  at: number
}

/** A batch of pending panel commands. */
export interface PanelCommandBatch {
  seq: number
  commands: PanelCommand[]
}

/** Workspace-wide notification settings. */
export interface OpsSettings {
  /** HTTP(S) webhook URL; empty means notifications are off. */
  webhookUrl?: string
  /** Send on every finished run, or only on failures. */
  webhookOn: 'always' | 'failure'
}

/** One task: a script plus its parameters, or a flow of other tasks. */
export interface OpsTask {
  id: string
  owner: TaskOwner
  name: string
  description?: string
  /** script (default) or flow. */
  kind: TaskKind
  /** Shell source, executed through `bash -s` on stdin. Empty for a flow. */
  script: string
  shell: 'bash'
  params: TaskParam[]
  env: Record<string, string>
  cwd?: string
  timeoutMs: number
  risk: TaskRisk
  /** all: every server of the owning service/system; single: one server. */
  scope: 'all' | 'single'
  /** Required when scope is single. */
  serverId?: string
  serverOverrides?: Record<string, ServerTaskOverride>
  /** Flow steps (kind: flow only). */
  steps?: FlowStep[]
  /** Flow failure policy (kind: flow only; default stop). */
  failure?: FlowFailure
  /** Optional cron schedule. */
  schedule?: TaskSchedule
  createdAt: number
  updatedAt: number
}

/** Full definitions snapshot the browser renders the tree from. */
export interface TreeSnapshot {
  revision: number
  systems: OpsSystem[]
  services: OpsService[]
  servers: OpsServer[]
  tasks: OpsTask[]
}

/** One host row in the server repository picker. */
export interface RepoHost {
  alias: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password' | 'agent'
  keyReady: boolean
  /** dsh-ssh `environment` doubles as the repository group. */
  group?: string
  tags: string[]
  description?: string
}

/** Import outcome from CSV or ~/.ssh/config. */
export interface ImportStats {
  parsed: number
  added: number
  skipped: number
  skippedBlocks?: Array<{ name: string; reason: string }>
}

/** Create-system payload. */
export interface SystemInput {
  name: string
  description?: string
  color?: string
}

/** Create-service payload. */
export interface ServiceInput {
  systemId: string
  name: string
  description?: string
  color?: string
}

/** New host credentials for the "direct add" path (mirrors dsh-ssh). */
export interface NewHostInput {
  alias: string
  host: string
  port?: number
  user: string
  auth: {
    kind: 'key' | 'password' | 'agent'
    keyPath?: string
    passphrase?: string
    password?: string
    agentPath?: string
  }
  /** Repository group (stored as the host entry's `environment`). */
  group?: string
  tags?: string[]
  description?: string
}

/** Create-server payload: pick a repository host, or create one inline. */
export interface ServerInput {
  serviceId: string
  /** Repository alias (mode: repo). */
  sshAlias?: string
  /** Inline host creation (mode: new). */
  newHost?: NewHostInput
  name?: string
  environment?: string
  runtime: RuntimeSpec
  /** Card accent (#rrggbb). */
  color?: string
  /** Generate the runtime's starter tasks at the service level. */
  generateTemplates?: boolean
}

/** Task create/update payload. */
export interface TaskInput {
  owner: TaskOwner
  name: string
  description?: string
  script: string
  params?: TaskParam[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  risk?: TaskRisk
  scope?: 'all' | 'single'
  serverId?: string
  serverOverrides?: Record<string, ServerTaskOverride>
  kind?: TaskKind
  steps?: FlowStepInput[]
  failure?: FlowFailure
  schedule?: TaskSchedule
}

/** Target state of one server in a run. */
export type TargetStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled' | 'skipped'

/** One server's outcome inside a run. */
export interface RunTarget {
  serverId: string
  alias: string
  status: TargetStatus
  exitCode: number | null
  durationMs: number
  error?: string
}

/** One flow step's child run inside the parent flow run. */
export interface RunChild {
  stepId: string
  taskId: string
  taskName: string
  /** The child run created for this step (absent until it starts). */
  runId?: string
  status: 'pending' | RunStatus
  startedAt?: number
  endedAt?: number
}

/** Overall run state. */
export type RunStatus = 'queued' | 'running' | 'ok' | 'failed' | 'partial' | 'cancelled' | 'skipped'

/** One run record. */
export interface OpsRun {
  id: string
  taskId: string
  taskName: string
  source: 'ui' | 'agent' | 'cron'
  initiator?: string
  status: RunStatus
  params: Record<string, string>
  targets: RunTarget[]
  /** Flow steps and their child runs (kind: flow only). */
  children?: RunChild[]
  startedAt: number
  endedAt?: number
  error?: string
}

/** Compact run row for history lists. */
export interface RunSummary {
  id: string
  taskId: string
  taskName: string
  source: 'ui' | 'agent' | 'cron'
  status: RunStatus
  targetCount: number
  okCount: number
  startedAt: number
  endedAt?: number
}

/** Run request. */
export interface RunInput {
  taskId: string
  params?: Record<string, string>
  /** Override the task's default targets (server ids). */
  serverIds?: string[]
  source?: 'ui' | 'agent' | 'cron'
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}
