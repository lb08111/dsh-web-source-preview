/**
 * Browser-half entry for the dsh-ops workspace — runs inside the dsh web GUI.
 *
 * Registers the locale dictionaries, binds the panel's translate seat and
 * mounts the native ops panel (sidebar row + center-column page). Failures are
 * logged, never thrown: an external plugin must not take the GUI down.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { OpsApi } from './api.ts'
import { registerBrand } from './brand.tsx'
import { createPanelPump } from './panel-pump.ts'
import { en, setRuntimeTranslate, zh, type OpsKey } from './locales.ts'
import { registerOpsPanel } from './native-panel.tsx'
import { OpsController } from './panel/controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-ops': OpsKey
  }
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-ops'

/** Required client services. */
export const inject = ['slots', 'locale', 'layout']

/** Mount the panel and its dictionaries. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-ops: dictionaries')

  try {
    setRuntimeTranslate(ctx.locale.bind(NS) as (key: OpsKey) => string)
  } catch {
    // Locale missing: tt() falls back to the Chinese dictionary.
  }

  const controller = new OpsController({
    select: (panelId) => {
      const layout = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as
        | { selectPanel?: (id: string | null) => void }
        | undefined
      layout?.selectPanel?.(panelId)
    },
  })
  const api = new OpsApi()

  try {
    registerBrand(ctx)
  } catch (error) {
    // Branding is cosmetic: never let it take the workspace down.
    console.warn('[dsh-ops] brand slots unavailable:', error)
  }

  ctx.effect(() => registerOpsPanel(ctx, controller, api), 'dsh-ops: panel')

  const pump = createPanelPump(controller, api)
  ctx.effect(() => pump.start(), 'dsh-ops: panel pump')
}
