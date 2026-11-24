/**
 * Hierarchy-tool contract: an operator can ask the agent for a system, its
 * services and its servers, and the agent's tools create each level through
 * the same ledger the panel uses.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PanelBus } from '../src/panel-bus.ts'
import { OpsStore } from '../src/store.ts'
import { RunStore } from '../src/runs.ts'
import { buildOpsTools } from '../src/tools.ts'
import type { OpsTransport } from '../src/transport.ts'
import type { TaskRunner } from '../src/runner.ts'

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A transport whose repository has one host. */
function fakeTransport(): OpsTransport {
  return {
    list: () => [{
      alias: 'app1-01',
      host: '10.0.0.11',
      port: 22,
      user: 'root',
      auth: 'password' as const,
      keyReady: true,
      environment: 'prod',
      tags: ['trade'],
    }],
    createHost: () => { throw new Error('inline host creation is not used in this test') },
  } as unknown as OpsTransport
}

/** Build the tools and a fresh ledger. */
function fixture(): {
  store: OpsStore
  tools: ReturnType<typeof buildOpsTools>
} {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ops-crud-'))
  const store = new OpsStore(join(dir, 'definitions.json'))
  const runs = new RunStore(join(dir, 'runs'))
  const tools = buildOpsTools(store, runs, {} as TaskRunner, new PanelBus(), fakeTransport())
  return { store, tools }
}

/** Find one tool by name or fail the test loudly. */
function toolNamed(tools: ReturnType<typeof buildOpsTools>, name: string) {
  const tool = tools.find(entry => entry.name === name)
  if (tool === undefined) throw new Error(`${name} tool missing`)
  return tool
}

describe('hierarchy tools', () => {
  it('operator asking for a system with a service and a server sees all three created', async () => {
    // Given the hierarchy tools and a repository host
    const { store, tools } = fixture()
    const systemTool = toolNamed(tools, 'ops_system_save')
    const serviceTool = toolNamed(tools, 'ops_service_save')
    const serverTool = toolNamed(tools, 'ops_server_save')

    // When the agent creates the system, its service and its server
    const systemResult = await systemTool.execute({ name: '交易系统' } as never, {} as never) as { ok: boolean; system?: { id: string } }
    expect(systemResult.ok).toBe(true)
    const systemId = systemResult.system?.id ?? ''
    const serviceResult = await serviceTool.execute({ systemId, name: '订单服务' } as never, {} as never) as { ok: boolean; service?: { id: string } }
    expect(serviceResult.ok).toBe(true)
    const serviceId = serviceResult.service?.id ?? ''
    const serverResult = await serverTool.execute({
      serviceId,
      sshAlias: 'app1-01',
      runtime: { kind: 'systemd', unit: 'trade-order', workdir: '/opt/trade-order', port: 8080 },
    } as never, {} as never) as { ok: boolean; tasks?: number }

    // Then the ledger holds the whole chain and starter tasks were generated
    const snapshot = store.snapshot()
    expect(serverResult.ok).toBe(true)
    expect(serverResult.tasks).toBeGreaterThan(0)
    expect(snapshot.systems.map(entry => entry.name)).toEqual(['交易系统'])
    expect(snapshot.services.map(entry => entry.name)).toEqual(['订单服务'])
    expect(snapshot.servers.map(entry => entry.sshAlias)).toEqual(['app1-01'])
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(5)
  })

  it('operator asking for an unknown repository alias sees the server tool refuse', async () => {
    // Given a service
    const { store, tools } = fixture()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    const serverTool = toolNamed(tools, 'ops_server_save')

    // When the agent references a host that is not in the repository
    const result = await serverTool.execute({
      serviceId: service.id,
      sshAlias: 'missing-host',
      runtime: { kind: 'systemd', unit: 'x' },
    } as never, {} as never) as { ok: boolean; error?: string }

    // Then it refuses instead of creating a dangling server
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not in the server repository')
    expect(store.snapshot().servers).toEqual([])
  })

  it('operator listing the repository sees aliases without secrets', async () => {
    // Given the repo tool
    const { tools } = fixture()
    const repo = toolNamed(tools, 'ops_repo')

    // When the agent lists hosts
    const result = await repo.execute({} as never, {} as never) as { ok: boolean; hosts?: Array<Record<string, unknown>> }

    // Then the alias and group are visible and no password field is returned
    expect(result.ok).toBe(true)
    expect(result.hosts?.[0]).toEqual(expect.objectContaining({ alias: 'app1-01', group: 'prod' }))
    expect(result.hosts?.[0]).not.toHaveProperty('password')
  })

  it('operator asking for a cascade delete without confirmation sees it refused', async () => {
    // Given a system
    const { store, tools } = fixture()
    const system = store.createSystem({ name: '交易系统' })
    const deleteTool = toolNamed(tools, 'ops_delete')

    // When the agent deletes without confirm
    const refused = await deleteTool.execute({ kind: 'system', id: system.id, confirm: false } as never, {} as never) as { ok: boolean }

    // Then nothing was deleted
    expect(refused.ok).toBe(false)
    expect(store.snapshot().systems).toHaveLength(1)

    // And with confirm the cascade succeeds
    const accepted = await deleteTool.execute({ kind: 'system', id: system.id, confirm: true } as never, {} as never) as { ok: boolean }
    expect(accepted.ok).toBe(true)
    expect(store.snapshot().systems).toEqual([])
  })
})
