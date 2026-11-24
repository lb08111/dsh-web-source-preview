/**
 * Structural contract for the dsh-ssh transport service this plugin injects.
 *
 * The ops package deliberately does NOT import dsh-ssh: the service is
 * resolved by name from the host composition and every member is expressed
 * structurally, so the ops ledger and runner can be unit-tested against a fake
 * transport and the two packages keep independent build graphs.
 */

import type { RepoHost } from './protocol.ts'

/** Cordis service name provided by dsh-ssh. */
export const SSH_TRANSPORT_SERVICE = 'sshTransport' as const

/** Host summary as the transport reports it (secret-free). */
export interface TransportHost {
  alias: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password' | 'agent'
  keyReady: boolean
  environment?: string
  tags: string[]
  description?: string
}

/** Host payload accepted by the transport (mirrors dsh-ssh's create/update). */
export interface TransportHostPayload {
  alias?: string
  host?: string
  port?: number
  user?: string
  auth?: {
    kind: 'key' | 'password' | 'agent'
    keyPath?: string
    passphrase?: string
    password?: string
    agentPath?: string
  }
  proxyJump?: string[]
  proxyCommand?: string
  description?: string
  environment?: string
  tags?: string[]
  location?: string
  forwardAgent?: boolean
}

/** Streaming exec options (mirrors dsh-ssh's contract). */
export interface TransportStreamOptions {
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

/** Streaming exec outcome. */
export interface TransportStreamResult {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  error?: string
}

/** One file transfer progress frame. */
export interface TransportTransferProgress {
  phase: 'connecting' | 'transferring' | 'done' | 'error'
  file: string
  transferred: number
  total: number
  percent: number
  speedBps?: number
  error?: string
}

/** Import outcome from ~/.ssh/config. */
export interface TransportImportResult {
  parsed: number
  added: number
  skipped: number
  skippedBlocks?: Array<{ name: string; reason: string }>
}

/** Connectivity probe result. */
export interface TransportTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** The slice of dsh-ssh the ops host half drives. */
export interface OpsTransport {
  list(query?: string): TransportHost[]
  execStream(alias: string, command: string, options?: TransportStreamOptions): Promise<TransportStreamResult>
  upload(alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransportTransferProgress) => void): Promise<{ bytes: number; files: number }>
  createHost(payload: TransportHostPayload): TransportHost
  updateHost(alias: string, patch: TransportHostPayload): TransportHost
  deleteHost(alias: string): void
  importSshConfig(): TransportImportResult
  test(alias: string): Promise<TransportTestResult>
}

/** Project one transport host onto the wire shape the picker renders. */
export function toRepoHost(host: TransportHost): RepoHost {
  return {
    alias: host.alias,
    host: host.host,
    port: host.port,
    user: host.user,
    auth: host.auth,
    keyReady: host.keyReady,
    group: host.environment,
    tags: [...host.tags],
    description: host.description,
  }
}
