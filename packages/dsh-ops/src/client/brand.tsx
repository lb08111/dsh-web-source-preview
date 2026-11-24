/**
 * Product branding for this deployment: the sidebar brand slots are owned by
 * the official brand plugin, which this bundle disables; these components
 * take their place and paint "测试管理平台" instead of the DeepSeek wordmark.
 *
 * The registration lives behind the same slots API the official plugin uses
 * (`sidebar.brand.mark` / `sidebar.brand.name`), so it survives shell updates.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { tt } from './locales.ts'

/** Accent gradient shared by the mark and the name. */
const GRADIENT = 'linear-gradient(135deg, #22d3ee 0%, #6366f1 100%)'

/** Square "AI" mark shown in the expanded sidebar and the collapsed rail. */
function AiTestMark({ size = 24 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: Math.max(6, Math.round(size * 0.28)),
        background: GRADIENT,
        boxShadow: '0 0 14px rgba(34, 211, 238, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.35)',
        color: '#04131f',
        fontSize: Math.max(9, Math.round(size * 0.42)),
        fontWeight: 800,
        letterSpacing: '-0.04em',
        lineHeight: 1,
      }}
    >
      测
    </span>
  )
}

/** Brand name: "AI-TEST" in the accent gradient, "管理台" quieter. */
function AiTestName() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        whiteSpace: 'nowrap',
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          fontSize: 14,
          fontWeight: 800,
          letterSpacing: '0.02em',
          background: GRADIENT,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        测试
      </span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-secondary)',
          letterSpacing: '0.08em',
        }}
      >
        {tt('brand.suffix')}
      </span>
    </span>
  )
}

/**
 * Register the brand slots and own the document title.
 * @param ctx - browser-half context (slots already injected).
 */
export function registerBrand(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, AiTestMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, AiTestName))
  if (typeof document !== 'undefined') {
    const title = tt('brand.title')
    document.title = title
    // The shell may set its own title after plugins load; keep ours.
    ctx.effect(() => {
      const apply = (): void => {
        if (document.title !== title) document.title = title
      }
      apply()
      const observer = new MutationObserver(apply)
      observer.observe(document.head, { subtree: true, childList: true, characterData: true })
      return () => { observer.disconnect() }
    }, 'dsh-ops: brand title')
  }
}
