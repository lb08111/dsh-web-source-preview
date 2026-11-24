/**
 * Panel-control contract: the host queue delivers each command once, the
 * browser pump opens/selects/refreshes, and a failing host never throws into
 * the page.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PanelBus } from '../src/panel-bus.ts'
import { OpsStore } from '../src/store.ts'
import { RunStore } from '../src/runs.ts'
import { buildOpsTools } from '../src/tools.ts'
import type { TaskRunner } from '../src/runner.ts'
import type { OpsTransport } from '../src/transport.ts'
import { OpsController } from '../src/client/panel/controller.ts'
import { createPanelPump } from '../src/client/panel-pump.ts'
import type { OpsApi } from '../src/client/api.ts'
import type { PanelCommandBatch } from '../src/protocol.ts'

describe('panel command bus', () => {
  it('operator polling since a sequence sees each queued command exactly once', () => {
    // Given a bus with two commands
    const bus = new PanelBus()
    bus.push('open', { kind: 'task', id: 'task-1' })
    bus.push('refresh')

    // When the browser polls from zero and then from the latest sequence
    const first = bus.since(0)
    const second = bus.since(first.seq)

    // Then the first poll carries both, the second carries none
    expect(first.commands.map(command => command.action)).toEqual(['open', 'refresh'])
    expect(second.commands).toEqual([])
    expect(second.seq).toBe(first.seq)
  })

  it('operator with a long sequence gap still sees the retained commands', () => {
    // Given more commands than the retention cap
    const bus = new PanelBus()
    for (let index = 0; index < 40; index += 1) bus.push('refresh')

    // When a very old client polls
    const batch = bus.since(0)

    // Then the queue is capped, not unbounded
    expect(batch.commands).toHaveLength(32)
    expect(batch.commands.at(-1)?.seq).toBe(40)
  })
})

describe('ops_panel tool', () => {
  it('operator asking the agent to show a task sees one queued open command', async () => {
    // Given a store with one task and a panel bus
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-panel-tool-'))
    try {
      const store = new OpsStore(join(dir, 'definitions.json'))
      const runs = new RunStore(join(dir, 'runs'))
      const system = store.createSystem({ name: '交易系统' })
      const service = store.createService({ systemId: system.id, name: '订单服务' })
      const task = store.createTask({
        owner: { kind: 'service', id: service.id },
        name: '重启服务',
        script: '#!/bin/bash\ntrue\n',
      })
      const panel = new PanelBus()
      const tools = buildOpsTools(store, runs, {} as TaskRunner, panel, {} as OpsTransport)
      const tool = tools.find(entry => entry.name === 'ops_panel')
      if (tool === undefined) throw new Error('ops_panel tool missing')

      // When the agent asks the browser to open that task
      const result = await tool.execute({ action: 'open', kind: 'task', id: task.id } as never, {} as never) as { ok: boolean }

      // Then exactly one open command is queued for that node
      expect(result.ok).toBe(true)
      expect(panel.since(0).commands).toEqual([
        expect.objectContaining({ action: 'open', node: { kind: 'task', id: task.id } }),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('operator asking for a missing node sees the tool refuse without queueing', async () => {
    // Given an empty store and a panel bus
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-panel-missing-'))
    try {
      const store = new OpsStore(join(dir, 'definitions.json'))
      const runs = new RunStore(join(dir, 'runs'))
      const panel = new PanelBus()
      const tools = buildOpsTools(store, runs, {} as TaskRunner, panel, {} as OpsTransport)
      const tool = tools.find(entry => entry.name === 'ops_panel')
      if (tool === undefined) throw new Error('ops_panel tool missing')

      // When the agent asks to show an unknown task
      const result = await tool.execute({ action: 'open', kind: 'task', id: 'task-missing' } as never, {} as never) as { ok: boolean; error?: string }

      // Then the tool refuses and nothing is queued
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
      expect(panel.since(0).commands).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('panel pump', () => {
  it('operator seeing an agent open command gets the panel opened on that node and refreshed', async () => {
    // Given a controller and a batch that opens one task
    const navigations: Array<string | null> = []
    const controller = new OpsController({ select: panelId => { navigations.push(panelId) } })
    const batch: PanelCommandBatch = {
      seq: 1,
      commands: [{ seq: 1, action: 'open', node: { kind: 'task', id: 'task-1' }, at: 1 }],
    }
    let polled = 0
    const api = {
      panelCommands: async () => {
        polled += 1
        return batch
      },
    } as unknown as OpsApi

    // When the pump runs one pass
    const pump = createPanelPump(controller, api)
    await pump.tick()

    // Then the layout switched to ops, the task is selected, and a reload was requested
    expect(navigations).toEqual(['ops'])
    expect(controller.getSnapshot().selection).toEqual({ kind: 'task', id: 'task-1' })
    expect(controller.getSnapshot().refreshToken).toBe(1)
    expect(polled).toBe(1)
  })

  it('operator with an unavailable host sees the pump swallow the error', async () => {
    // Given a controller and an API that rejects
    const controller = new OpsController()
    const api = { panelCommands: async () => { throw new Error('host restarting') } } as unknown as OpsApi

    // When the pump runs
    const pump = createPanelPump(controller, api)

    // Then the tick resolves without changing the selection
    await expect(pump.tick()).resolves.toBeUndefined()
    expect(controller.getSnapshot().selection).toEqual({ kind: 'root' })
  })
})
