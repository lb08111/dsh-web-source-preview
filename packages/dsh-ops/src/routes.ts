/**
 * The /api/dsh-ops route family: tree CRUD, the server repository (list,
 * import CSV, import ~/.ssh/config), task CRUD, and run control (start,
 * detail, log tail, cancel).
 *
 * Every route carries the same loopback-only trust fence as the SSH family:
 * these endpoints execute user scripts on remote servers, so a LAN-exposed
 * deployment must not serve them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readJsonBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { importHostsCsv } from './import.ts'
import { OPS_API, type OpsSettings, type ServerInput, type ServiceInput, type SystemInput, type TaskInput } from './protocol.ts'
import type { PanelBus } from './panel-bus.ts'
import type { TaskRunner } from './runner.ts'
import type { RunStore } from './runs.ts'
import { addServerWithTemplates } from './server-create.ts'
import { toRepoHost, type OpsTransport } from './transport.ts'
import type { OpsStore } from './store.ts'

/** Route family dependencies. */
export interface OpsRoutesDeps {
  store: OpsStore
  runs: RunStore
  runner: TaskRunner
  transport: OpsTransport
  panel: PanelBus
}

/** First query value. */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** One JSON body object or a written 400. */
async function bodyObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const body = await readJsonBody(req, { objectOnly: true })
  if (body === null) {
    writeJson(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
  return body as Record<string, unknown>
}

/** Build every /api/dsh-ops route (exact paths). */
export function makeOpsRoutes(deps: OpsRoutesDeps): WebRoute[] {
  const { store, runs, runner, transport, panel } = deps

  /** Fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string | string[]): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    const allowed = Array.isArray(method) ? method : [method]
    if (!allowed.includes(req.method ?? '')) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** Run one handler, folding thrown domain errors into a 400. */
  const attempt = (res: ServerResponse, fn: () => void | Promise<void>): Promise<void> => {
    return Promise.resolve()
      .then(fn)
      .catch((error: unknown) => {
        writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      })
  }

  return [
    // ------------------------------------------------------------ tree
    {
      kind: 'exact',
      path: OPS_API.tree,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { tree: store.snapshot() })
      },
    },

    // ----------------------------------------------------------- systems
    {
      kind: 'exact',
      path: OPS_API.systems,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!guard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        await attempt(res, async () => {
          if (method === 'GET') {
            writeJson(res, 200, { systems: store.systems() })
            return
          }
          if (method === 'POST') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const system = store.createSystem(body as unknown as SystemInput)
            writeJson(res, 201, { system })
            return
          }
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') throw new Error('id query parameter is required')
          if (method === 'PATCH') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const system = store.updateSystem(id, body as unknown as Partial<SystemInput>)
            writeJson(res, 200, { system })
            return
          }
          store.deleteSystem(id)
          writeJson(res, 200, { ok: true })
        })
      },
    },

    // ---------------------------------------------------------- services
    {
      kind: 'exact',
      path: OPS_API.services,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!guard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        await attempt(res, async () => {
          if (method === 'GET') {
            writeJson(res, 200, { services: store.services() })
            return
          }
          if (method === 'POST') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const service = store.createService(body as unknown as ServiceInput)
            writeJson(res, 201, { service })
            return
          }
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') throw new Error('id query parameter is required')
          if (method === 'PATCH') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const service = store.updateService(id, body as unknown as Partial<ServiceInput>)
            writeJson(res, 200, { service })
            return
          }
          store.deleteService(id)
          writeJson(res, 200, { ok: true })
        })
      },
    },

    // ----------------------------------------------------------- servers
    {
      kind: 'exact',
      path: OPS_API.servers,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!guard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        await attempt(res, async () => {
          if (method === 'GET') {
            const serviceId = queryParam(url, 'serviceId')
            writeJson(res, 200, {
              servers: serviceId === undefined || serviceId === ''
                ? store.servers()
                : store.serversOfService(serviceId),
            })
            return
          }
          if (method === 'POST') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const { server, tasks } = addServerWithTemplates(store, transport, body as unknown as ServerInput)
            writeJson(res, 201, { server, tasks })
            return
          }
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') throw new Error('id query parameter is required')
          if (method === 'PATCH') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const server = store.updateServer(id, body as unknown as Partial<ServerInput>)
            writeJson(res, 200, { server })
            return
          }
          store.deleteServer(id)
          writeJson(res, 200, { ok: true })
        })
      },
    },

    // -------------------------------------------------------- repository
    {
      kind: 'exact',
      path: OPS_API.repo,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const query = queryParam(url, 'query')
        writeJson(res, 200, { hosts: transport.list(query).map(toRepoHost) })
      },
    },
    {
      kind: 'exact',
      path: OPS_API.repoTest,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await bodyObject(req, res)
        if (body === undefined) return
        const alias = typeof body.alias === 'string' ? body.alias : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        await attempt(res, async () => {
          writeJson(res, 200, { result: await transport.test(alias) })
        })
      },
    },
    {
      kind: 'exact',
      path: OPS_API.repoImportCsv,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await bodyObject(req, res)
        if (body === undefined) return
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim() === '') {
          writeJson(res, 400, { error: 'text is required' })
          return
        }
        writeJson(res, 200, { result: importHostsCsv(text, transport) })
      },
    },
    {
      kind: 'exact',
      path: OPS_API.repoImportSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await attempt(res, () => {
          writeJson(res, 200, { result: transport.importSshConfig() })
        })
      },
    },

    // ------------------------------------------------------------- tasks
    {
      kind: 'exact',
      path: OPS_API.tasks,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!guard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        await attempt(res, async () => {
          if (method === 'GET') {
            const owner = queryParam(url, 'owner')
            if (owner === undefined || owner === '') {
              writeJson(res, 200, { tasks: store.tasks() })
              return
            }
            const separator = owner.indexOf(':')
            if (separator <= 0) throw new Error("owner must look like 'service:<id>' or 'system:<id>'")
            const kind = owner.slice(0, separator)
            if (kind !== 'service' && kind !== 'system') throw new Error("owner kind must be 'service' or 'system'")
            writeJson(res, 200, { tasks: store.tasksOfOwner(kind, owner.slice(separator + 1)) })
            return
          }
          if (method === 'POST') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const task = store.createTask(body as unknown as TaskInput)
            writeJson(res, 201, { task })
            return
          }
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') throw new Error('id query parameter is required')
          if (method === 'PATCH') {
            const body = await bodyObject(req, res)
            if (body === undefined) return
            const task = store.updateTask(id, body as unknown as Partial<TaskInput>)
            writeJson(res, 200, { task })
            return
          }
          store.deleteTask(id)
          writeJson(res, 200, { ok: true })
        })
      },
    },

    // ------------------------------------------------------ panel control
    {
      kind: 'exact',
      path: OPS_API.panelCommands,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = Number(queryParam(url, 'since') ?? '0')
        const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
        writeJson(res, 200, panel.since(since))
      },
    },

    // ---------------------------------------------------------- settings
    {
      kind: 'exact',
      path: OPS_API.settings,
      handler: async (req, res) => {
        if (!guard(req, res, ['GET', 'PATCH'])) return
        await attempt(res, async () => {
          if (req.method === 'GET') {
            writeJson(res, 200, { settings: store.settings() })
            return
          }
          const body = await bodyObject(req, res)
          if (body === undefined) return
          writeJson(res, 200, { settings: store.updateSettings(body as Partial<OpsSettings>) })
        })
      },
    },

    // -------------------------------------------------------------- runs
    {
      kind: 'exact',
      path: OPS_API.runs,
      handler: async (req, res) => {
        if (!guard(req, res, ['GET', 'POST'])) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        await attempt(res, async () => {
          if (req.method === 'GET') {
            const limitText = queryParam(url, 'limit')
            const limit = limitText === undefined ? 50 : Number.parseInt(limitText, 10)
            writeJson(res, 200, { runs: runs.list(Number.isFinite(limit) ? limit : 50) })
            return
          }
          const body = await bodyObject(req, res)
          if (body === undefined) return
          const taskId = typeof body.taskId === 'string' ? body.taskId : ''
          if (taskId === '') throw new Error('taskId is required')
          const params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
            ? body.params as Record<string, string>
            : undefined
          const serverIds = Array.isArray(body.serverIds)
            ? body.serverIds.filter((id): id is string => typeof id === 'string')
            : undefined
          const source = body.source === 'agent' ? 'agent' : 'ui'
          const run = await runner.start(taskId, { params, serverIds, source })
          writeJson(res, 200, { run })
        })
      },
    },
    {
      kind: 'exact',
      path: OPS_API.runDetail,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = queryParam(url, 'id')
        if (id === undefined || id === '') {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        const run = runs.get(id)
        if (run === undefined) {
          writeJson(res, 404, { error: `run '${id}' not found` })
          return
        }
        writeJson(res, 200, { run })
      },
    },
    {
      kind: 'exact',
      path: OPS_API.runLog,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = queryParam(url, 'id')
        const target = queryParam(url, 'server')
        if (id === undefined || id === '' || target === undefined || target === '') {
          writeJson(res, 400, { error: 'id and server query parameters are required' })
          return
        }
        const text = runs.readLog(id, target)
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end(text)
      },
    },
    {
      kind: 'exact',
      path: OPS_API.runCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = queryParam(url, 'id')
        if (id === undefined || id === '') {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        writeJson(res, 200, { cancelled: runner.cancel(id) })
      },
    },
  ]
}
