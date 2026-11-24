/**
 * Panel controller: the single owner of the workspace selection.
 *
 * Framework-free (structural runtime faces) so the sidebar row and the React
 * panel share one tiny subscription surface. The selection outlives the page
 * mount, so switching to another panel and back returns to the same node.
 */

/** Node kinds the panel can select. `run` is a transient detail view. */
export type OpsNodeKind = 'root' | 'system' | 'service' | 'server' | 'task' | 'run'

/** One selected node. */
export interface OpsSelection {
  kind: OpsNodeKind
  id?: string
}

/** Immutable controller snapshot for UI subscriptions. */
export interface OpsControllerSnapshot {
  selection: OpsSelection
  /** Bumped by host-issued panel commands to ask the page to reload. */
  refreshToken: number
}

/** Stable id shared by the sidebar panel row and the main-slot page. */
export const OPS_PANEL_ID = 'ops'

/** The layout's panel-navigation face (absent in a shell-less composition). */
export interface PanelNavigationFace {
  /** Select this panel, or null to hand the column back to the conversation. */
  select(panelId: string | null): void
}

/** The workspace selection controller. */
export class OpsController {
  private snapshot: OpsControllerSnapshot = { selection: { kind: 'root' }, refreshToken: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly nav: PanelNavigationFace | undefined

  /**
   * @param nav - optional layout panel selection.
   */
  constructor(nav?: PanelNavigationFace) {
    this.nav = nav
  }

  /** Subscribe to selection changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Current snapshot (stable until a selection changes). */
  getSnapshot = (): OpsControllerSnapshot => this.snapshot

  /** Select one node (or the root overview). */
  select(selection: OpsSelection): void {
    this.snapshot = { ...this.snapshot, selection }
    for (const listener of [...this.listeners]) listener()
  }

  /** Ask the mounted page to reload its data (keeps the selection). */
  refresh(): void {
    this.snapshot = { ...this.snapshot, refreshToken: this.snapshot.refreshToken + 1 }
    for (const listener of [...this.listeners]) listener()
  }

  /** Ask the shell to show this panel. */
  open(): void {
    this.nav?.select(OPS_PANEL_ID)
  }

  /** Hand the center column back to the conversation. */
  close(): void {
    this.nav?.select(null)
  }
}
