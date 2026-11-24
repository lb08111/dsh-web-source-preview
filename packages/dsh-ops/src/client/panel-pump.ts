/**
 * Browser-side pump for host-issued panel commands.
 *
 * The agent's `ops_panel` tool enqueues a command in the Host; this pump polls
 * `/api/dsh-ops/panel/commands` and applies new entries to the shared panel
 * controller: switch the center column to the ops page, select the node, and
 * reload the tree so a task the agent just created is visible.
 *
 * Polling (rather than a socket) keeps the plugin independent of the shell's
 * transport and works even while the ops page is not mounted.
 */

import type { OpsApi } from './api.ts'
import type { OpsController, OpsSelection } from './panel/controller.ts'

/** One pump instance (tick is public for tests). */
export interface PanelPump {
  tick(): Promise<void>
  start(): () => void
  stop(): void
}

/**
 * Create the command pump.
 * @param controller - panel selection owner.
 * @param api - ops HTTP client.
 * @param intervalMs - poll cadence (default 1s).
 * @returns the pump; `tick()` runs one pass.
 */
export function createPanelPump(controller: OpsController, api: OpsApi, intervalMs = 1_000): PanelPump {
  let since = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function tick(): Promise<void> {
    let batch: Awaited<ReturnType<OpsApi['panelCommands']>>
    try {
      batch = await api.panelCommands(since)
    } catch {
      // Host restarting or route not mounted yet: try again next pass.
      return
    }
    if (stopped) return
    since = batch.seq
    for (const command of batch.commands) {
      if (command.action === 'refresh') {
        controller.refresh()
        continue
      }
      if (command.node === undefined) continue
      const node: OpsSelection = command.node.kind === 'root'
        ? { kind: 'root' }
        : { kind: command.node.kind, id: command.node.id }
      controller.open()
      controller.select(node)
      controller.refresh()
    }
  }

  function stop(): void {
    stopped = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  function start(): () => void {
    if (timer !== undefined) return stop
    stopped = false
    void tick()
    timer = setInterval(() => { void tick() }, intervalMs)
    timer.unref?.()
    return stop
  }

  return { tick, start, stop }
}
