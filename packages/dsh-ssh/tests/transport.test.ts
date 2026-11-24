/** The shared SSH transport keeps repository imports available to ops consumers. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { createSshTransport } from '../src/transport.ts'
import type { OpsTransport } from '../../dsh-ops/src/transport.ts'

let dir: string | undefined
let engine: SshEngine | undefined

afterEach(() => {
  engine?.dispose()
  engine = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('shared SSH transport', () => {
  it('operator imports SSH config through the ops transport and can select the imported host', () => {
    // Given an isolated SSH config and the same store the SSH UI reads
    dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-transport-'))
    const configPath = join(dir, 'config')
    writeFileSync(configPath, 'Host app-test\n  HostName 192.0.2.10\n  User tester\n', 'utf8')
    const store = new HostStore(join(dir, 'hosts.json'), configPath)
    engine = new SshEngine(store)
    const transport: OpsTransport = createSshTransport(engine)

    // When an ops consumer imports the config through the shared service
    const first = transport.importSshConfig()

    // Then the repository contains that host and another import preserves it
    expect(first).toMatchObject({ parsed: 1, added: 1, skipped: 0 })
    expect(transport.list()).toEqual([expect.objectContaining({
      alias: 'app-test', host: '192.0.2.10', user: 'tester',
    })])
    expect(transport.importSshConfig()).toMatchObject({ parsed: 1, added: 0, skipped: 1 })
    expect(store.list()).toHaveLength(1)
  })
})
