/**
 * Runner behavior: target fan-out, parameter precedence, file uploads, log
 * capture, failure accounting and cancellation — all against a fake transport.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '../src/store.ts'
import { RunStore } from '../src/runs.ts'
import { TaskRunner } from '../src/runner.ts'
import type {
  OpsTransport,
  TransportHost,
  TransportHostPayload,
  TransportImportResult,
  TransportStreamOptions,
  TransportStreamResult,
  TransportTestResult,
} from '../src/transport.ts'
import type { OpsServer, TaskInput } from '../src/protocol.ts'

/** A scripted transport that records calls and returns a fixed outcome. */
class FakeTransport implements OpsTransport {
  readonly calls: Array<{ alias: string; command: string; stdin: string }> = []
  readonly uploads: Array<{ alias: string; localPath: string; remotePath: string }> = []
  readonly created: TransportHostPayload[] = []
  result: TransportStreamResult = { exitCode: 0, timedOut: false, durationMs: 1 }
  output = 'hello\n'
  onExec: (() => void) | undefined

  async execStream(alias: string, command: string, options: TransportStreamOptions = {}): Promise<TransportStreamResult> {
    this.calls.push({ alias, command, stdin: options.stdin ?? '' })
    this.onExec?.()
    options.onStdout?.(this.output)
    // A script that carries FAIL exits non-zero, so a flow can mix outcomes.
    if ((options.stdin ?? '').includes('FAIL')) {
      return { exitCode: 1, timedOut: false, durationMs: 1 }
    }
    return this.result
  }

  async upload(alias: string, localPath: string, remotePath: string): Promise<{ bytes: number; files: number }> {
    this.uploads.push({ alias, localPath, remotePath })
    return { bytes: 1, files: 1 }
  }

  list(): TransportHost[] {
    return []
  }

  createHost(payload: TransportHostPayload): TransportHost {
    this.created.push(payload)
    return {
      alias: payload.alias ?? '',
      host: payload.host ?? '',
      port: payload.port ?? 22,
      user: payload.user ?? '',
      auth: payload.auth?.kind ?? 'password',
      keyReady: true,
      tags: payload.tags ?? [],
    }
  }

  updateHost(alias: string, patch: TransportHostPayload): TransportHost {
    return { alias, host: patch.host ?? '', port: 22, user: '', auth: 'password', keyReady: true, tags: [] }
  }

  deleteHost(): void {}

  importSshConfig(): TransportImportResult {
    return { parsed: 0, added: 0, skipped: 0 }
  }

  async test(): Promise<TransportTestResult> {
    return { ok: true }
  }
}

/** A transport whose exec waits until the caller aborts. */
class BlockingTransport extends FakeTransport {
  started!: () => void
  readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve })

  override async execStream(_alias: string, _command: string, options: TransportStreamOptions = {}): Promise<TransportStreamResult> {
    this.started()
    return await new Promise<TransportStreamResult>((resolve) => {
      options.signal?.addEventListener('abort', () => {
        resolve({ exitCode: null, timedOut: false, durationMs: 1, error: 'command cancelled by the caller' })
      })
    })
  }
}

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** One service with the requested number of servers. */
function fixture(servers: number): { store: OpsStore; runs: RunStore; list: OpsServer[]; serviceId: string } {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ops-runner-'))
  const store = new OpsStore(join(dir, 'definitions.json'))
  const runs = new RunStore(join(dir, 'runs'))
  const system = store.createSystem({ name: '交易系统' })
  const service = store.createService({ systemId: system.id, name: '订单服务' })
  const created: OpsServer[] = []
  for (let index = 1; index <= servers; index += 1) {
    created.push(store.createServer({
      serviceId: service.id,
      sshAlias: `test-app1-0${index}`,
      runtime: { kind: 'systemd', unit: 'trade-order', workdir: '/opt/trade-order', port: 8080 },
    }))
  }
  return { store, runs, list: created, serviceId: service.id }
}

/** Minimal task input. */
function taskInput(serviceId: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    owner: { kind: 'service', id: serviceId },
    name: '重启服务',
    script: '#!/bin/bash\nsystemctl restart trade-order\n',
    ...overrides,
  }
}

describe('task runner', () => {
  it('operator running a task on two servers sees both succeed and their output logged', async () => {
    // Given a service with two servers and one shared task
    const { store, runs, serviceId } = fixture(2)
    const task = store.createTask(taskInput(serviceId))
    const transport = new FakeTransport()

    // When the operator starts the task
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id)
    const finished = await runner.wait(started.id)

    // Then both targets ran, succeeded, and kept their own log
    expect(finished?.status).toBe('ok')
    expect(finished?.targets.map(target => target.status)).toEqual(['ok', 'ok'])
    expect(transport.calls).toHaveLength(2)
    expect(runs.readLog(started.id, started.targets[0].serverId)).toBe('hello\n')
    expect(transport.calls[0]?.stdin).toContain('systemctl restart trade-order')
  })

  it('operator sees a non-zero exit recorded as a failed target', async () => {
    // Given a transport that returns exit code 7
    const { store, runs, serviceId } = fixture(1)
    const task = store.createTask(taskInput(serviceId))
    const transport = new FakeTransport()
    transport.result = { exitCode: 7, timedOut: false, durationMs: 3 }

    // When the operator runs the task
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id)
    const finished = await runner.wait(started.id)

    // Then the run and the target are failed with the exit code preserved
    expect(finished?.status).toBe('failed')
    expect(finished?.targets[0]?.status).toBe('failed')
    expect(finished?.targets[0]?.exitCode).toBe(7)
  })

  it('operator passing parameters sees them as env assignments plus built-ins', async () => {
    // Given a task with a required VERSION parameter
    const { store, runs, serviceId } = fixture(1)
    const task = store.createTask(taskInput(serviceId, {
      params: [{ name: 'VERSION', type: 'text', required: true }],
    }))
    const transport = new FakeTransport()

    // When the operator runs it with VERSION=1.2.4
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id, { params: { VERSION: '1.2.4' } })
    await runner.wait(started.id)

    // Then the script command carries the parameter and the server built-ins
    const command = transport.calls[0]?.command ?? ''
    expect(command).toContain("VERSION='1.2.4'")
    expect(command).toContain("DSH_SERVER_ALIAS='test-app1-01'")
    expect(command).toContain("DSH_SERVER_WORKDIR='/opt/trade-order'")
    expect(command.endsWith('bash -s')).toBe(true)
  })

  it('operator uploading a file parameter sees it staged on the target and its remote path injected', async () => {
    // Given a task with a file parameter and a real local file
    const { store, runs, serviceId } = fixture(1)
    const local = join(dir!, 'order-service.jar')
    writeFileSync(local, 'jar-bytes', 'utf8')
    const task = store.createTask(taskInput(serviceId, {
      params: [{ name: 'ARTIFACT', type: 'file', required: true }],
    }))
    const transport = new FakeTransport()

    // When the operator runs it with the local path
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id, { params: { ARTIFACT: local } })
    await runner.wait(started.id)

    // Then the file was uploaded to the run staging dir and the env points there
    expect(transport.uploads).toHaveLength(1)
    expect(transport.uploads[0]?.remotePath).toMatch(/^\/tmp\/dsh-ops\/.+\/order-service\.jar$/)
    expect(transport.calls[0]?.command).toContain(`ARTIFACT='${transport.uploads[0]?.remotePath}'`)
  })

  it('operator overriding one server sees that server use the override value', async () => {
    // Given two servers where the second overrides PORT
    const { store, runs, list, serviceId } = fixture(2)
    const task = store.createTask(taskInput(serviceId, {
      params: [{ name: 'PORT', type: 'number', default: '8080' }],
      serverOverrides: { [list[1]!.id]: { params: { PORT: '9090' } } },
    }))
    const transport = new FakeTransport()

    // When the operator runs the task
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id)
    await runner.wait(started.id)

    // Then the first command uses 8080 and the second uses the override
    expect(transport.calls[0]?.command).toContain("PORT='8080'")
    expect(transport.calls[1]?.command).toContain("PORT='9090'")
  })

  it('operator running a flow sees every step executed in order', async () => {
    // Given two script tasks and a flow listing them in order
    const { store, runs, serviceId } = fixture(1)
    const first = store.createTask(taskInput(serviceId, { name: '先执行', script: '#!/bin/bash\necho FIRST\n' }))
    const second = store.createTask(taskInput(serviceId, { name: '后执行', script: '#!/bin/bash\necho SECOND\n' }))
    const flow = store.createTask({
      owner: { kind: 'service', id: serviceId },
      name: '发布链',
      kind: 'flow',
      script: '',
      steps: [{ taskId: first.id, mode: 'serial' }, { taskId: second.id, mode: 'serial' }],
      failure: 'stop',
    })
    const transport = new FakeTransport()

    // When the operator runs the flow
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(flow.id)
    const finished = await runner.wait(started.id)

    // Then both child runs succeeded, in declaration order, and the parent is ok
    expect(finished?.error).toBeUndefined()
    expect(finished?.status).toBe('ok')
    expect(finished?.children?.map(child => child.status)).toEqual(['ok', 'ok'])
    expect(transport.calls).toHaveLength(2)
    expect(transport.calls[0]?.stdin).toContain('FIRST')
    expect(transport.calls[1]?.stdin).toContain('SECOND')
  })

  it('operator narrowing a flow to one server sees the runtime target and parameter reach the step', async () => {
    // Given a two-server task in a flow with a saved parameter value
    const { store, runs, list, serviceId } = fixture(2)
    const deploy = store.createTask(taskInput(serviceId, {
      name: '发布',
      script: '#!/bin/bash\necho "VERSION=${VERSION}"\n',
      params: [{ name: 'VERSION', type: 'text', required: true }],
    }))
    const flow = store.createTask({
      owner: { kind: 'service', id: serviceId },
      name: '发布链',
      kind: 'flow',
      script: '',
      steps: [{ taskId: deploy.id, mode: 'serial', params: { VERSION: 'saved' } }],
      failure: 'stop',
    })
    const transport = new FakeTransport()

    // When the operator runs the flow for one server with a runtime parameter
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(flow.id, {
      params: { VERSION: 'runtime' },
      serverIds: [list[0]!.id],
    })
    const finished = await runner.wait(started.id)

    // Then the runtime target remains the upper bound and the runtime value wins
    expect(finished?.status).toBe('ok')
    expect(transport.calls.map(call => call.alias)).toEqual(['test-app1-01'])
    expect(transport.calls[0]?.command).toContain("VERSION='runtime'")
  })

  it('operator whose runtime and step targets do not overlap sees the step fail without executing', async () => {
    // Given a step saved for the second server
    const { store, runs, list, serviceId } = fixture(2)
    const inspect = store.createTask(taskInput(serviceId, { name: '巡检' }))
    const flow = store.createTask({
      owner: { kind: 'service', id: serviceId },
      name: '受限巡检',
      kind: 'flow',
      script: '',
      steps: [{ taskId: inspect.id, mode: 'serial', serverIds: [list[1]!.id] }],
      failure: 'stop',
    })
    const transport = new FakeTransport()

    // When the operator narrows the flow to the first server
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(flow.id, { serverIds: [list[0]!.id] })
    const finished = await runner.wait(started.id)

    // Then the empty intersection fails closed and reaches no server
    expect(finished?.status).toBe('failed')
    expect(finished?.children?.[0]?.status).toBe('failed')
    expect(transport.calls).toHaveLength(0)
  })

  it('operator with a stop policy sees the remaining steps skipped after a failure', async () => {
    // Given a flow whose second step fails and a third step after it
    const { store, runs, serviceId } = fixture(1)
    const ok = store.createTask(taskInput(serviceId, { name: '成功', script: '#!/bin/bash\necho OK\n' }))
    const bad = store.createTask(taskInput(serviceId, { name: '失败', script: '#!/bin/bash\n# FAIL\nexit 1\n' }))
    const later = store.createTask(taskInput(serviceId, { name: '后续', script: '#!/bin/bash\necho LATER\n' }))
    const flow = store.createTask({
      owner: { kind: 'service', id: serviceId },
      name: '会失败的链',
      kind: 'flow',
      script: '',
      steps: [
        { taskId: ok.id, mode: 'serial' },
        { taskId: bad.id, mode: 'serial' },
        { taskId: later.id, mode: 'serial' },
      ],
      failure: 'stop',
    })
    const transport = new FakeTransport()

    // When the operator runs the flow
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(flow.id)
    const finished = await runner.wait(started.id)

    // Then the failed step stops the chain and the last step never runs
    expect(finished?.status).toBe('failed')
    expect(finished?.children?.map(child => child.status)).toEqual(['ok', 'failed', 'skipped'])
    expect(transport.calls).toHaveLength(2)
  })

  it('operator with a continue policy sees the chain finish after a failure', async () => {
    // Given the same failing middle step, with failure: continue
    const { store, runs, serviceId } = fixture(1)
    const ok = store.createTask(taskInput(serviceId, { name: '成功', script: '#!/bin/bash\necho OK\n' }))
    const bad = store.createTask(taskInput(serviceId, { name: '失败', script: '#!/bin/bash\n# FAIL\nexit 1\n' }))
    const later = store.createTask(taskInput(serviceId, { name: '后续', script: '#!/bin/bash\necho LATER\n' }))
    const flow = store.createTask({
      owner: { kind: 'service', id: serviceId },
      name: '继续的链',
      kind: 'flow',
      script: '',
      steps: [
        { taskId: ok.id, mode: 'serial' },
        { taskId: bad.id, mode: 'serial' },
        { taskId: later.id, mode: 'serial' },
      ],
      failure: 'continue',
    })
    const transport = new FakeTransport()

    // When the operator runs the flow
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(flow.id)
    const finished = await runner.wait(started.id)

    // Then the last step still runs and the parent reports a partial result
    expect(finished?.status).toBe('partial')
    expect(finished?.children?.map(child => child.status)).toEqual(['ok', 'failed', 'ok'])
    expect(transport.calls).toHaveLength(3)
  })

  it('operator with a webhook sees the finished run posted once', async () => {
    // Given always-on webhook settings and a fake fetch
    const { store, runs, serviceId } = fixture(1)
    store.updateSettings({ webhookUrl: 'http://hook.test/run', webhookOn: 'always' })
    const task = store.createTask(taskInput(serviceId))
    const calls: Array<{ url: string; body: string }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return { ok: true, status: 200 } as Response
    }) as typeof fetch
    const runner = new TaskRunner(store, runs, new FakeTransport(), { fetchImpl: fakeFetch })

    // When the task runs to completion
    const started = await runner.start(task.id)
    await runner.wait(started.id)
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    // Then exactly one webhook was posted with the finished run
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://hook.test/run')
    const body = JSON.parse(calls[0]?.body ?? '{}') as { event?: string; run?: { status?: string } }
    expect(body.event).toBe('ops.run.finished')
    expect(body.run?.status).toBe('ok')
  })

  it('operator cancelling a running task sees the target and the run marked cancelled', async () => {
    // Given a transport whose command waits for the abort signal
    const { store, runs, serviceId } = fixture(1)
    const task = store.createTask(taskInput(serviceId))
    const transport = new BlockingTransport()
    const runner = new TaskRunner(store, runs, transport)
    const started = await runner.start(task.id)
    await transport.startedPromise

    // When the operator cancels the run
    expect(runner.cancel(started.id)).toBe(true)
    const finished = await runner.wait(started.id)

    // Then the run and its target are cancelled
    expect(finished?.status).toBe('cancelled')
    expect(finished?.targets[0]?.status).toBe('cancelled')
  })
})
