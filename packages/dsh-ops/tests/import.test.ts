/**
 * Server-repository import: CSV parsing and the batch contract (bad rows are
 * skipped with a reason, never abort the import).
 */

import { describe, expect, it } from 'vitest'
import { importHostsCsv, parseCsv } from '../src/import.ts'
import type {
  OpsTransport,
  TransportHost,
  TransportHostPayload,
  TransportImportResult,
  TransportStreamOptions,
  TransportStreamResult,
  TransportTestResult,
} from '../src/transport.ts'

/** A transport that records createHost payloads. */
class FakeTransport implements OpsTransport {
  readonly created: TransportHostPayload[] = []

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
      environment: payload.environment,
    }
  }

  list(): TransportHost[] { return [] }
  updateHost(alias: string): TransportHost {
    return { alias, host: '', port: 22, user: '', auth: 'password', keyReady: true, tags: [] }
  }
  deleteHost(): void {}
  importSshConfig(): TransportImportResult { return { parsed: 0, added: 0, skipped: 0 } }
  async test(): Promise<TransportTestResult> { return { ok: true } }
  async execStream(_alias: string, _command: string, _options?: TransportStreamOptions): Promise<TransportStreamResult> {
    return { exitCode: 0, timedOut: false, durationMs: 0 }
  }
  async upload(): Promise<{ bytes: number; files: number }> { return { bytes: 0, files: 0 } }
}

describe('server repository import', () => {
  it('operator importing CSV with a header sees hosts, groups and tags applied', () => {
    // Given a CSV with a header, one grouped host and two tags
    const csv = [
      'alias,host,port,user,password,group,tags',
      'app1-01,10.20.1.11,22,root,secret,交易,核心;java',
      'app2-01,10.20.2.11,,deploy,pass,支付,',
    ].join('\n')
    const transport = new FakeTransport()

    // When the operator imports it
    const result = importHostsCsv(csv, transport)

    // Then both hosts were created with the group mapped to environment
    expect(result.parsed).toBe(2)
    expect(result.added).toBe(2)
    expect(result.skipped).toBe(0)
    expect(transport.created[0]?.environment).toBe('交易')
    expect(transport.created[0]?.tags).toEqual(['核心', 'java'])
    expect(transport.created[0]?.auth).toEqual({ kind: 'password', password: 'secret' })
    expect(transport.created[1]?.port).toBe(22)
  })

  it('operator importing CSV with a broken row sees that row skipped with a reason', () => {
    // Given a CSV whose second row has no host
    const csv = [
      'alias,host,user,password',
      'app1-01,10.20.1.11,root,secret',
      'app1-02,,root,secret',
    ].join('\n')
    const transport = new FakeTransport()

    // When the operator imports it
    const result = importHostsCsv(csv, transport)

    // Then the good row lands and the bad row is reported, not thrown
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.skippedBlocks?.[0]?.reason).toMatch(/host is required/)
    expect(transport.created).toHaveLength(1)
  })

  it('operator importing CSV without a header sees the documented column order applied', () => {
    // Given a headerless CSV in alias,host,port,user,password order
    const csv = 'app1-01,10.20.1.11,2222,root,secret'
    const transport = new FakeTransport()

    // When the operator imports it
    const result = importHostsCsv(csv, transport)

    // Then the port and credentials land on the created host
    expect(result.added).toBe(1)
    expect(transport.created[0]?.port).toBe(2222)
    expect(transport.created[0]?.user).toBe('root')
  })

  it('operator pasting a quoted CSV field sees commas and quotes preserved', () => {
    // Given a CSV row whose description contains a comma and a doubled quote
    const rows = parseCsv('alias,host,description\napp1-01,10.20.1.11,"a, b ""quoted"""')

    // When parsed
    // Then the field is one value with the punctuation intact
    expect(rows[1]?.[2]).toBe('a, b "quoted"')
  })
})
