/**
 * Native panel registration for the ops workspace.
 *
 * The panel is an official-style center-column page: it contributes a row into
 * the sidebar shell's own panel list (`sidebar.panellist`) and its page into
 * the layout's keyed `main` slot. The shell owns the row box, label, highlight
 * and panel switching; this package only owns the page content.
 *
 * Both registrations go through `ctx.slots.inject`, which fires only once the
 * owning shell entry declares the seat, so load order does not matter and a
 * shell that cannot serve the seats simply leaves the panel absent.
 *
 * @module @linxin666/dsh-ops/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { OpsApi } from './api.ts'
import { OPS_PANEL_ID, type OpsController } from './panel/controller.ts'
import { tt } from './locales.ts'
import { OpsPanel } from './panel/OpsPanel.tsx'
import css from './panel/panel.module.css'

/** The panel id shared by the sidebar row and the main-slot occupant. */
export { OPS_PANEL_ID }

/** Row order among the shell's global panel rows (SSH is 40). */
const PANEL_ORDER = 50

/**
 * The sidebar row glyph the shell asks for at its own size.
 * @param props - square edge and selection state.
 * @returns the decorative tree glyph.
 */
export function OpsPanelIcon({ size }: { size: number; active: boolean }): ReactElement {
  return (
    <svg
      data-dsh-panel-entry={OPS_PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.5h4v3H3z" />
      <path d="M9 9.5h4v3H9z" />
      <path d="M5 6.5v5h4" />
      <path d="M5 9.5h4" />
    </svg>
  )
}

/** The main-slot page. */
export function OpsPanelPage({ controller, api }: {
  controller: OpsController
  api: OpsApi
}): ReactElement {
  return (
    <div className={css.view} data-dsh-ops-view="" data-dsh-plugin="ops">
      <OpsPanel controller={controller} api={api} />
    </div>
  )
}

/** The injected face both registrations receive. */
interface PanelFace {
  controller: OpsController
  api: OpsApi
}

/**
 * Register the ops sidebar row and center-column page.
 * @param ctx - client root context (service: slots).
 * @param controller - selection owner.
 * @param api - API client.
 * @returns disposer releasing both registrations.
 */
export function registerOpsPanel(ctx: ClientContext, controller: OpsController, api: OpsApi): () => void {
  const slots = ctx.slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const disposers: Array<() => void> = []

  disposers.push(slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: OPS_PANEL_ID,
    order: PANEL_ORDER,
    label: () => tt('entry.label'),
  }, OpsPanelIcon)))

  disposers.push(slots.inject('main', () => slots.register({
    name: 'main',
    key: OPS_PANEL_ID,
    inject: (): PanelFace => ({ controller, api }),
  }, OpsPanelPage as never)))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
