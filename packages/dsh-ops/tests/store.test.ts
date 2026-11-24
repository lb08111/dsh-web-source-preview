/**
 * Ledger behavior: tree creation, cascade deletion, scope resolution and the
 * corrupt-file quarantine contract.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '../src/store.ts'
import type { TaskInput } from '../src/protocol.ts'

let dir: string | undefined

function makeStore(): OpsStore {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ops-store-'))
  return new OpsStore(join(dir, 'definitions.json'))
}

/** Minimal valid task payload. */
function taskPayload(ownerId: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    owner: { kind: 'service', id: ownerId },
    name: '重启服务',
    script: '#!/bin/bash\nsystemctl restart demo\n',
    ...overrides,
  }
}

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('ops ledger', () => {
  it('operator creates a system, service, server and task and reads the tree back', () => {
    // Given an empty definitions file
    const store = makeStore()

    // When the operator builds one branch of the tree
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    const server = store.createServer({
      serviceId: service.id,
      sshAlias: 'test-app1-01',
      runtime: { kind: 'systemd', unit: 'trade-order', workdir: '/opt/trade-order', port: 8080 },
    })
    const task = store.createTask(taskPayload(service.id))

    // Then the snapshot carries every node with stable ids and defaults
    const snapshot = store.snapshot()
    expect(snapshot.systems).toHaveLength(1)
    expect(snapshot.services[0]?.systemId).toBe(system.id)
    expect(snapshot.servers[0]?.sshAlias).toBe('test-app1-01')
    expect(snapshot.servers[0]?.runtime.port).toBe(8080)
    expect(snapshot.tasks[0]?.id).toBe(task.id)
    expect(snapshot.tasks[0]?.scope).toBe('all')
    expect(snapshot.tasks[0]?.risk).toBe('write')
    expect(server.name).toBe('test-app1-01')
  })

  it('operator deleting a system removes its services, servers and tasks', () => {
    // Given a system with one service, one server and one task
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    store.createServer({ serviceId: service.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } })
    store.createTask(taskPayload(service.id))

    // When the operator deletes the system
    store.deleteSystem(system.id)

    // Then nothing under it survives
    const snapshot = store.snapshot()
    expect(snapshot.systems).toEqual([])
    expect(snapshot.services).toEqual([])
    expect(snapshot.servers).toEqual([])
    expect(snapshot.tasks).toEqual([])
  })

  it('operator cannot attach the same host twice to one service', () => {
    // Given a service that already hosts one alias
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    store.createServer({ serviceId: service.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } })

    // When the operator attaches that alias again
    // Then the ledger refuses instead of creating a duplicate
    expect(() => store.createServer({ serviceId: service.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } }))
      .toThrow(/already attached/)
  })

  it('operator resolving a service task targets every server of that service', () => {
    // Given a service with two servers
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    store.createServer({ serviceId: service.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } })
    store.createServer({ serviceId: service.id, sshAlias: 'test-app1-02', runtime: { kind: 'systemd' } })

    // When the operator reads the task's default targets
    const task = store.createTask(taskPayload(service.id))
    const targets = store.targetsOfTask(task)

    // Then both servers are included
    expect(targets.map(server => server.sshAlias).sort()).toEqual(['test-app1-01', 'test-app1-02'])
  })

  it('operator narrowing a task to a single server outside its service is refused', () => {
    // Given two services, each with one server
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const order = store.createService({ systemId: system.id, name: '订单服务' })
    const pay = store.createService({ systemId: system.id, name: '支付服务' })
    store.createServer({ serviceId: order.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } })
    const payServer = store.createServer({ serviceId: pay.id, sshAlias: 'test-app2-01', runtime: { kind: 'systemd' } })

    // When the operator creates an order-service task pinned to the payment server
    // Then the ledger refuses the mismatched target
    expect(() => store.createTask(taskPayload(order.id, { scope: 'single', serverId: payServer.id })))
      .toThrow(/owning service/)
  })

  it('operator creating a flow sees its steps stored with generated ids', () => {
    // Given a service with two script tasks
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    store.createServer({ serviceId: service.id, sshAlias: 'test-app1-01', runtime: { kind: 'systemd' } })
    const first = store.createTask(taskPayload(service.id, { name: '先执行' }))
    const second = store.createTask(taskPayload(service.id, { name: '后执行' }))

    // When the operator creates a flow over them
    const flow = store.createTask({
      owner: { kind: 'service', id: service.id },
      name: '发布链',
      kind: 'flow',
      script: '',
      steps: [{ taskId: first.id }, { taskId: second.id, mode: 'parallel' }],
      failure: 'continue',
    })

    // Then the flow is stored with ids, modes and its failure policy
    expect(flow.kind).toBe('flow')
    expect(flow.steps).toHaveLength(2)
    expect(flow.steps?.[0]?.id).toMatch(/^step-/)
    expect(flow.steps?.[0]?.mode).toBe('serial')
    expect(flow.steps?.[1]?.mode).toBe('parallel')
    expect(flow.failure).toBe('continue')
    expect(store.targetsOfTask(flow)).toEqual([])
  })

  it('operator referencing an unknown task from a flow step is refused', () => {
    // Given a service with one script task
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    store.createTask(taskPayload(service.id))

    // When the operator creates a flow over a missing task id
    // Then the ledger refuses the dangling reference
    expect(() => store.createTask({
      owner: { kind: 'service', id: service.id },
      name: '坏链',
      kind: 'flow',
      script: '',
      steps: [{ taskId: 'task-missing' }],
    })).toThrow(/unknown task/)
  })

  it('operator cannot delete a script task that a flow still references', () => {
    // Given a flow that references one script task
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    const script = store.createTask(taskPayload(service.id))
    store.createTask({
      owner: { kind: 'service', id: service.id },
      name: '发布链',
      kind: 'flow',
      script: '',
      steps: [{ taskId: script.id }],
    })

    // When the operator deletes the referenced task
    // Then the ledger refuses and names the flow
    expect(() => store.deleteTask(script.id)).toThrow(/used by flow/)
  })

  it('operator saving a schedule with an invalid cron is refused', () => {
    // Given a service with one script task
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })

    // When the operator saves a malformed cron
    // Then the ledger refuses it
    expect(() => store.createTask(taskPayload(service.id, {
      schedule: { enabled: true, cron: '61 * * * *' },
    }))).toThrow(/invalid cron/)
  })

  it('operator saving a valid schedule sees it stored with its zone and enable flag', () => {
    // Given a service with one script task
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })

    // When the operator saves a daily 02:00 schedule in Shanghai
    const task = store.createTask(taskPayload(service.id, {
      schedule: { enabled: true, cron: '0 2 * * *', timeZone: 'Asia/Shanghai' },
    }))

    // Then the schedule round-trips through the ledger
    const read = store.task(task.id)
    expect(read?.schedule).toEqual({ enabled: true, cron: '0 2 * * *', timeZone: 'Asia/Shanghai' })
  })

  it('operator saving webhook settings sees them round-trip and the URL checked', () => {
    // Given an empty ledger with default settings
    const store = makeStore()
    expect(store.settings()).toEqual({ webhookOn: 'failure' })

    // When the operator saves an http endpoint
    const saved = store.updateSettings({ webhookUrl: 'https://hook.test/run', webhookOn: 'always' })
    expect(saved).toEqual({ webhookUrl: 'https://hook.test/run', webhookOn: 'always' })

    // Then a non-http value is refused
    expect(() => store.updateSettings({ webhookUrl: 'ftp://hook.test/run' })).toThrow(/http/)
  })

  it('operator recording a scheduled trigger sees lastRunAt persist', () => {
    // Given a task with a schedule
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统' })
    const service = store.createService({ systemId: system.id, name: '订单服务' })
    const task = store.createTask(taskPayload(service.id, {
      schedule: { enabled: true, cron: '* * * * *' },
    }))

    // When the scheduler records a trigger
    store.markScheduleRun(task.id, 1_700_000_000_000)

    // Then the stored schedule carries it
    expect(store.task(task.id)?.schedule?.lastRunAt).toBe(1_700_000_000_000)
  })

  it('operator saving an invalid card color is refused', () => {
    // Given an empty store
    const store = makeStore()

    // When the operator saves a non-hex accent
    // Then the ledger refuses it
    expect(() => store.createSystem({ name: '交易系统', color: 'blue' })).toThrow(/#rrggbb/)
    expect(() => store.createSystem({ name: '交易系统', color: '#12345' })).toThrow(/#rrggbb/)
  })

  it('operator clearing a card color sees it removed from the entity', () => {
    // Given a system with a custom accent
    const store = makeStore()
    const system = store.createSystem({ name: '交易系统', color: '#22D3EE' })
    expect(system.color).toBe('#22d3ee')

    // When the operator clears it
    const cleared = store.updateSystem(system.id, { color: '' })

    // Then the entity keeps no accent and inherits the default again
    expect(cleared.color).toBeUndefined()
  })

  it('operator finds a corrupt definitions file quarantined instead of overwritten', () => {
    // Given a definitions file whose content is not valid JSON
    const store = makeStore()
    writeFileSync(join(dir!, 'definitions.json'), '{not json', 'utf8')

    // When the operator reads the ledger
    const snapshot = store.snapshot()

    // Then it starts empty and the corrupt file was renamed aside
    expect(snapshot.systems).toEqual([])
    expect(readdirSync(dir!).some(name => name.includes('.corrupt-'))).toBe(true)
  })
})
