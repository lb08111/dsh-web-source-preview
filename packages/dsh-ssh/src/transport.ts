/**
 * The transport face another host plugin (the ops workspace) drives instead of
 * importing this package's internals. Every member is a thin forward of the
 * engine or host store method of the same name — no gate, no normalization and
 * no state lives here, so a consumer reaching the engine this way is refused by
 * exactly what refuses the agent tools and the HTTP routes.
 *
 * Streaming exec is exposed separately from buffered exec: the ops runner
 * feeds a script through stdin and consumes output as it arrives, and that path
 * is deliberately not replayed after a broken connection.
 */

import type { SshEngine } from './engine.ts'
import type {
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
  HostPayload,
  ImportResult,
  RemoteDirEntry,
  SshHostSummary,
  TestResult,
  TransferProgress,
} from './protocol.ts'

/** Cordis service name the ops layer injects. */
export const SSH_TRANSPORT_SERVICE = 'sshTransport' as const

/** The host-side surface another plugin may resolve and drive. */
export interface SshTransport {
  /** Secret-free host list (optional fuzzy query). */
  list(query?: string): SshHostSummary[]
  /** One host summary by alias. */
  find(alias: string): SshHostSummary | undefined
  /** Buffered command execution. */
  exec(alias: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>
  /** Streamed command execution with an optional stdin payload. */
  execStream(alias: string, command: string, options?: ExecStreamOptions): Promise<ExecStreamResult>
  /** Upload one local file or directory tree. */
  upload(alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number; files: number }>
  /** Download one remote file. */
  download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number }>
  /** List a remote directory. */
  ls(alias: string, path: string): Promise<RemoteDirEntry[]>
  /** Probe connectivity. */
  test(alias: string): Promise<TestResult>
  /** Create a host entry (the ops server-repository "direct add" path). */
  createHost(payload: HostPayload): SshHostSummary
  /** Update a host entry; connection-relevant changes drop the pooled link. */
  updateHost(alias: string, patch: Partial<HostPayload>): SshHostSummary
  /** Remove a host entry and its pooled link. */
  deleteHost(alias: string): void
  /** Import the host's OpenSSH config into the shared repository. */
  importSshConfig(): ImportResult
}

/**
 * Build the transport face over one engine instance.
 * @param engine - the plugin's engine (owns the pool and the host store).
 * @returns the service value to provide.
 */
export function createSshTransport(engine: SshEngine): SshTransport {
  return {
    list: query => engine.list(query),
    find: alias => engine.find(alias),
    exec: (alias, command, timeoutMs, signal) => engine.exec(alias, command, timeoutMs, signal),
    execStream: (alias, command, options) => engine.execStream(alias, command, options),
    upload: (alias, localPath, remotePath, recursive, onProgress) => engine.upload(alias, localPath, remotePath, recursive, onProgress),
    download: (alias, remotePath, localPath, onProgress) => engine.download(alias, remotePath, localPath, onProgress),
    ls: (alias, path) => engine.ls(alias, path),
    test: alias => engine.test(alias),
    createHost: payload => engine.store.summarize(engine.store.create(payload)),
    updateHost: (alias, patch) => {
      const entry = engine.store.update(alias, patch)
      // A changed connection must reconnect with the new config; the pool is
      // dropped after the write so a failed update keeps the live link.
      engine.dropAlias(alias)
      return engine.store.summarize(entry)
    },
    deleteHost: (alias) => {
      engine.dropAlias(alias)
      engine.store.delete(alias)
    },
    importSshConfig: () => engine.store.importFromSshConfig(),
  }
}
