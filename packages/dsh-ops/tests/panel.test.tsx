// @vitest-environment jsdom
/**
 * Panel render contract: the workspace fetches the tree and paints every node
 * kind without a host round-trip beyond tree/runs.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsController } from '../src/client/panel/controller.ts'
import { OpsPanel } from '../src/client/panel/OpsPanel.tsx'
import type { OpsApi } from '../src/client/api.ts'
import type { TreeSnapshot } from '../src/protocol.ts'

const snapshot: TreeSnapshot = {
  revision: 1,
  systems: [{ id: 'sys-1', name: '交易系统', createdAt: 1, updatedAt: 1 }],
  services: [{ id: 'svc-1', systemId: 'sys-1', name: '订单服务', createdAt: 1, updatedAt: 1 }],
  servers: [{
    id: 'srv-1',
    serviceId: 'svc-1',
    sshAlias: 'app1-01',
    name: 'app1-01',
    runtime: { kind: 'systemd', unit: 'trade-order', workdir: '/opt/trade-order', port: 8080 },
    createdAt: 1,
    updatedAt: 1,
  }],
  tasks: [{
    id: 'task-1',
    owner: { kind: 'service', id: 'svc-1' },
    kind: 'script',
    name: '重启服务',
    script: '#!/bin/bash\nsystemctl restart trade-order\n',
    shell: 'bash',
    params: [],
    env: {},
    timeoutMs: 120_000,
    risk: 'write',
    scope: 'all',
    createdAt: 1,
    updatedAt: 1,
  }],
}

/** The panel only calls tree() and runs() on mount. */
function fakeApi(): OpsApi {
  return {
    tree: async () => snapshot,
    runs: async () => [],
    settings: async () => ({ webhookOn: 'failure' as const }),
  } as unknown as OpsApi
}

let container: HTMLDivElement | undefined

afterEach(() => {
  if (container !== undefined) container.remove()
  container = undefined
})

describe('ops panel', () => {
  it('operator opening the workspace sees card dashboards and can drill down', async () => {
    // Given a workspace with one system, service, server and task
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const controller = new OpsController()

    // When the operator opens the panel
    await act(async () => {
      root.render(<OpsPanel controller={controller} api={fakeApi()} />)
    })
    await act(async () => { await Promise.resolve() })

    // Then the landing page is a card dashboard with the system card
    let text = container.textContent ?? ''
    expect(text).toContain('测试管理平台')
    expect(text).toContain('交易系统')
    expect(text).toContain('订单服务')

    // And drilling into the system shows the service card with its server chip
    await act(async () => { controller.select({ kind: 'system', id: 'sys-1' }) })
    text = container.textContent ?? ''
    expect(text).toContain('订单服务')
    expect(text).toContain('app1-01')

    // And the service board shows server and task cards
    await act(async () => { controller.select({ kind: 'service', id: 'svc-1' }) })
    text = container.textContent ?? ''
    expect(text).toContain('app1-01')
    expect(text).toContain('重启服务')
    expect(text).toContain('运行')

    await act(async () => { root.unmount() })
  })
})
