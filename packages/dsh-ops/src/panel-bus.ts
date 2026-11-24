/**
 * Host -> browser panel command bus.
 *
 * The agent runs in the Host; the panel runs in the browser. There is no
 * generic host-to-client event channel in the shell, so a small bounded queue
 * lets an agent tool ask the panel to open a node: the browser polls
 * `/api/dsh-ops/panel/commands?since=<seq>` and applies the new entries.
 *
 * Commands are UI-only and ephemeral (in-memory, capped, with a TTL): a missed
 * command must never change data, and a stale command must not yank the UI long
 * after the fact.
 */

import type { PanelCommand, PanelCommandBatch } from './protocol.ts'

/** How many commands to retain. */
const CAPACITY = 32

/** Commands older than this are dropped before delivery. */
const TTL_MS = 5 * 60_000

/** One bounded, monotonic command queue. */
export class PanelBus {
  private readonly commands: PanelCommand[] = []
  private seq = 0

  /**
   * Append one command.
   * @param action - open/select/refresh.
   * @param node - target node for open/select.
   * @returns the command sequence number.
   */
  push(action: PanelCommand['action'], node?: PanelCommand['node']): number {
    this.seq += 1
    this.commands.push({
      seq: this.seq,
      action,
      ...(node === undefined ? {} : { node }),
      at: Date.now(),
    })
    if (this.commands.length > CAPACITY) this.commands.splice(0, this.commands.length - CAPACITY)
    return this.seq
  }

  /**
   * Commands the browser has not seen yet.
   * @param since - last sequence the browser applied.
   * @returns the current sequence and the newer commands (expired ones dropped).
   */
  since(since: number): PanelCommandBatch {
    const cutoff = Date.now() - TTL_MS
    while (this.commands.length > 0 && this.commands[0].at < cutoff) this.commands.shift()
    return {
      seq: this.seq,
      commands: this.commands.filter(command => command.seq > since),
    }
  }

  /** Drop every pending command. */
  clear(): void {
    this.commands.length = 0
  }
}
