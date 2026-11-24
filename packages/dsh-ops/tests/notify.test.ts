/**
 * Webhook contract: failure-only vs always, the payload projection, and the
 * best-effort behavior for HTTP and transport failures.
 */

import { describe, expect, it } from 'vitest'
import { buildWebhookPayload, sendRunWebhook, shouldNotify } from '../src/notify.ts'
import type { OpsRun } from '../src/protocol.ts'

/** One finished script run. */
function runFixture(status: OpsRun['status']): OpsRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    taskName: '重启服务',
    source: 'ui',
    status,
    params: {},
    targets: [{ serverId: 'srv-1', alias: 'app1-01', status: 'ok', exitCode: 0, durationMs: 12 }],
    startedAt: 1,
    endedAt: 2,
  }
}

describe('run webhook', () => {
  it('operator choosing failures-only sees successful runs skipped', () => {
    // Given failure-only notification settings
    const settings = { webhookUrl: 'https://hook.test/run', webhookOn: 'failure' as const }

    // When the run succeeded
    // Then nothing is sent; a failed run is sent
    expect(shouldNotify(settings, runFixture('ok'))).toBe(false)
    expect(shouldNotify(settings, runFixture('failed'))).toBe(true)
    expect(shouldNotify({ webhookOn: 'failure' }, runFixture('failed'))).toBe(false)
  })

  it('operator choosing always sees every finished run posted', () => {
    // Given always-on settings
    const settings = { webhookUrl: 'https://hook.test/run', webhookOn: 'always' as const }

    // When posting a failed run through a fake fetch
    const calls: Array<{ url: string; body: string }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return { ok: true, status: 200 } as Response
    }) as typeof fetch

    // Then the URL and event body are what the endpoint receives
    return sendRunWebhook(settings, runFixture('failed'), fakeFetch).then((result) => {
      expect(result.sent).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('https://hook.test/run')
      const body = JSON.parse(calls[0]?.body ?? '{}') as { event?: string; run?: { id?: string } }
      expect(body.event).toBe('ops.run.finished')
      expect(body.run?.id).toBe('run-1')
    })
  })

  it('operator with a failing endpoint sees the run keep its outcome', async () => {
    // Given an endpoint that answers 500 and one that throws
    const settings = { webhookUrl: 'https://hook.test/run', webhookOn: 'always' as const }
    const failingFetch = (async () => ({ ok: false, status: 500 } as Response)) as typeof fetch
    const throwingFetch = (async () => { throw new Error('boom') }) as typeof fetch

    // When posting the run
    const failed = await sendRunWebhook(settings, runFixture('failed'), failingFetch)
    const thrown = await sendRunWebhook(settings, runFixture('failed'), throwingFetch)

    // Then delivery reports the error without throwing
    expect(failed.sent).toBe(false)
    expect(failed.error).toContain('500')
    expect(thrown.sent).toBe(false)
    expect(thrown.error).toContain('boom')
  })

  it('operator receiving a flow payload sees step statuses instead of targets', () => {
    // Given a finished flow run with two children
    const run: OpsRun = {
      ...runFixture('failed'),
      targets: [],
      children: [
        { stepId: 'step-1', taskId: 'task-a', taskName: '查看状态', status: 'ok', runId: 'run-a' },
        { stepId: 'step-2', taskId: 'task-b', taskName: '重启服务', status: 'skipped' },
      ],
    }

    // When projecting the webhook body
    const payload = buildWebhookPayload(run)

    // Then the summary counts steps and the steps array carries their statuses
    expect(payload.summary).toEqual({ okSteps: 1, stepCount: 2 })
    expect(payload.steps).toEqual([
      { taskName: '查看状态', status: 'ok', runId: 'run-a' },
      { taskName: '重启服务', status: 'skipped' },
    ])
    expect(payload.targets).toEqual([])
  })
})
