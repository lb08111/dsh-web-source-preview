/**
 * Browser API client for the ops route family. Same-origin fetch; every route
 * is loopback-fenced on the host, so this client never leaves the local page.
 */

import {
  OPS_API,
  type ImportStats,
  type OpsRun,
  type OpsServer,
  type PanelCommandBatch,
  type OpsSettings,
  type RuntimeSpec,
  type OpsService,
  type OpsSystem,
  type OpsTask,
  type RepoHost,
  type RunSummary,
  type ServerInput,
  type TaskInput,
  type TreeSnapshot,
} from '../protocol.ts'

/** Parse one JSON response or throw the server's error text. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  const raw = await response.text()
  if (!response.ok) {
    let message = raw
    try {
      const parsed = JSON.parse(raw) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch { /* raw text is the message */ }
    throw new Error(message === '' ? `request failed: ${response.status}` : message)
  }
  return (raw === '' ? undefined : JSON.parse(raw)) as T
}

/** Encode a query string, dropping empty values. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** The ops API surface. */
export class OpsApi {
  /** Full tree snapshot. */
  async tree(): Promise<TreeSnapshot> {
    const body = await request<{ tree: TreeSnapshot }>(OPS_API.tree)
    return body.tree
  }

  // ------------------------------------------------------------ systems
  async createSystem(name: string): Promise<OpsSystem> {
    const body = await request<{ system: OpsSystem }>(OPS_API.systems, { method: 'POST', body: JSON.stringify({ name }) })
    return body.system
  }

  async updateSystem(id: string, patch: { name?: string; description?: string; color?: string }): Promise<OpsSystem> {
    const body = await request<{ system: OpsSystem }>(OPS_API.systems + query({ id }), { method: 'PATCH', body: JSON.stringify(patch) })
    return body.system
  }

  async deleteSystem(id: string): Promise<void> {
    await request(OPS_API.systems + query({ id }), { method: 'DELETE' })
  }

  // ----------------------------------------------------------- services
  async createService(systemId: string, name: string): Promise<OpsService> {
    const body = await request<{ service: OpsService }>(OPS_API.services, { method: 'POST', body: JSON.stringify({ systemId, name }) })
    return body.service
  }

  async updateService(id: string, patch: { name?: string; description?: string; color?: string }): Promise<OpsService> {
    const body = await request<{ service: OpsService }>(OPS_API.services + query({ id }), { method: 'PATCH', body: JSON.stringify(patch) })
    return body.service
  }

  async deleteService(id: string): Promise<void> {
    await request(OPS_API.services + query({ id }), { method: 'DELETE' })
  }

  // ------------------------------------------------------------ servers
  async createServer(input: ServerInput): Promise<{ server: OpsServer; tasks: number }> {
    return await request<{ server: OpsServer; tasks: number }>(OPS_API.servers, { method: 'POST', body: JSON.stringify(input) })
  }

  async updateServer(id: string, patch: { name?: string; runtime?: RuntimeSpec; color?: string }): Promise<OpsServer> {
    const body = await request<{ server: OpsServer }>(OPS_API.servers + query({ id }), { method: 'PATCH', body: JSON.stringify(patch) })
    return body.server
  }

  async deleteServer(id: string): Promise<void> {
    await request(OPS_API.servers + query({ id }), { method: 'DELETE' })
  }

  // --------------------------------------------------------- repository
  async repo(queryText?: string): Promise<RepoHost[]> {
    const body = await request<{ hosts: RepoHost[] }>(OPS_API.repo + query({ query: queryText }))
    return body.hosts
  }

  async testHost(alias: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const body = await request<{ result: { ok: boolean; latencyMs?: number; error?: string } }>(OPS_API.repoTest, {
      method: 'POST',
      body: JSON.stringify({ alias }),
    })
    return body.result
  }

  async importCsv(text: string): Promise<ImportStats> {
    const body = await request<{ result: ImportStats }>(OPS_API.repoImportCsv, { method: 'POST', body: JSON.stringify({ text }) })
    return body.result
  }

  async importSshConfig(): Promise<ImportStats> {
    const body = await request<{ result: ImportStats }>(OPS_API.repoImportSshConfig, { method: 'POST' })
    return body.result
  }

  // -------------------------------------------------------------- tasks
  async createTask(input: TaskInput): Promise<OpsTask> {
    const body = await request<{ task: OpsTask }>(OPS_API.tasks, { method: 'POST', body: JSON.stringify(input) })
    return body.task
  }

  async updateTask(id: string, patch: Partial<TaskInput>): Promise<OpsTask> {
    const body = await request<{ task: OpsTask }>(OPS_API.tasks + query({ id }), { method: 'PATCH', body: JSON.stringify(patch) })
    return body.task
  }

  async deleteTask(id: string): Promise<void> {
    await request(OPS_API.tasks + query({ id }), { method: 'DELETE' })
  }

  // ------------------------------------------------------- panel control
  async panelCommands(since: number): Promise<PanelCommandBatch> {
    return await request<PanelCommandBatch>(OPS_API.panelCommands + query({ since }))
  }

  // ----------------------------------------------------------- settings
  async settings(): Promise<OpsSettings> {
    const body = await request<{ settings: OpsSettings }>(OPS_API.settings)
    return body.settings
  }

  async updateSettings(patch: Partial<OpsSettings>): Promise<OpsSettings> {
    const body = await request<{ settings: OpsSettings }>(OPS_API.settings, { method: 'PATCH', body: JSON.stringify(patch) })
    return body.settings
  }

  // --------------------------------------------------------------- runs
  async runs(limit = 50): Promise<RunSummary[]> {
    const body = await request<{ runs: RunSummary[] }>(OPS_API.runs + query({ limit }))
    return body.runs
  }

  async run(taskId: string, params: Record<string, string>, serverIds?: string[]): Promise<OpsRun> {
    const body = await request<{ run: OpsRun }>(OPS_API.runs, {
      method: 'POST',
      body: JSON.stringify({ taskId, params, serverIds }),
    })
    return body.run
  }

  async runDetail(id: string): Promise<OpsRun> {
    const body = await request<{ run: OpsRun }>(OPS_API.runDetail + query({ id }))
    return body.run
  }

  async runLog(id: string, serverId: string): Promise<string> {
    const response = await fetch(OPS_API.runLog + query({ id, server: serverId }))
    if (!response.ok) throw new Error(`log unavailable: ${response.status}`)
    return await response.text()
  }

  async cancelRun(id: string): Promise<boolean> {
    const body = await request<{ cancelled: boolean }>(OPS_API.runCancel + query({ id }), { method: 'POST' })
    return body.cancelled
  }
}
