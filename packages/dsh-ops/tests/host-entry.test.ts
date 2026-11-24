/** A disabled host entry must leave scheduled remote work inactive. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { OpsStore } from '../src/store.ts'
import { RunStore } from '../src/runs.ts'

class RecordingTransport {
  readonly commands: string[] = []

  async execStream(_alias: string, command: string): Promise<{ exitCode: number; timedOut: boolean; durationMs: number }> {
    this.commands.push(command)
    return { exitCode: 0, timedOut: false, durationMs: 1 }
  }
}

class TestHost {
  readonly sshTransport = new RecordingTransport()
  private readonly cleanups: Array<() => void> = []

  effect(setup: () => () => void): () => void {
    const cleanup = setup()
    this.cleanups.push(cleanup)
    return cleanup
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
  }
}

let dir: string | undefined
let host: TestHost | undefined

afterEach(() => {
  host?.dispose()
  host = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('ops host entry', () => {
  it('operator disabling the workspace sees no scheduled remote run', async () => {
    // Given an enabled task schedule inside an isolated DSH home
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 0, 30))
    dir = mkdtempSync(join(tmpdir(), 'dsh-ops-host-entry-'))
    vi.stubEnv('DSH_HOME', dir)
    const store = new OpsStore()
    const system = store.createSystem({ name: 'demo' })
    const service = store.createService({ systemId: system.id, name: 'app' })
    store.createServer({ serviceId: service.id, sshAlias: 'app-test', runtime: { kind: 'custom' } })
    store.createTask({
      owner: { kind: 'service', id: service.id }, name: 'probe', script: 'true\n',
      schedule: { enabled: true, cron: '* * * * *' },
    })
    host = new TestHost()

    // When the disabled plugin remains mounted across a due boundary
    apply(host as unknown as Context, { enabled: false })
    await vi.advanceTimersByTimeAsync(90_000)

    // Then no run is created and no remote command is submitted
    expect(new RunStore().list()).toEqual([])
    expect(host.sshTransport.commands).toEqual([])
  })

  it('operator gets agent announcements only after opting in', () => {
    // Given an empty profile config
    // When its defaults are resolved
    const config = Config({})

    // Then the workspace is enabled with its announcement disabled
    expect(config.enabled).toBe(true)
    expect(config.announceToAgent).toBe(false)
    expect(Config({ announceToAgent: true }).announceToAgent).toBe(true)
  })
})
