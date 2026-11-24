/**
 * Run-completion webhooks.
 *
 * A finished run is posted as one JSON document to the workspace webhook URL.
 * Delivery is best-effort and bounded: a slow or failing endpoint never
 * changes the run's outcome, and the payload is a projection of the run record
 * (no command output and no credentials).
 */

import type { OpsRun, OpsSettings } from './protocol.ts'

/** Outcome of one webhook attempt. */
export interface WebhookResult {
  sent: boolean
  error?: string
}

/** Whether these settings ask for this run. */
export function shouldNotify(settings: OpsSettings, run: OpsRun): boolean {
  if (settings.webhookUrl === undefined || settings.webhookUrl === '') return false
  if (settings.webhookOn === 'failure') return run.status !== 'ok'
  return true
}

/** Project a run into the webhook body (secret-free, output-free). */
export function buildWebhookPayload(run: OpsRun): Record<string, unknown> {
  const okCount = run.targets.filter(target => target.status === 'ok').length
  return {
    event: 'ops.run.finished',
    run: {
      id: run.id,
      taskId: run.taskId,
      taskName: run.taskName,
      status: run.status,
      source: run.source,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
    },
    summary: {
      ...(run.targets.length === 0 ? {} : { okCount, targetCount: run.targets.length }),
      ...(run.children === undefined ? {} : {
        okSteps: run.children.filter(child => child.status === 'ok').length,
        stepCount: run.children.length,
      }),
    },
    targets: run.targets.map(target => ({
      alias: target.alias,
      status: target.status,
      exitCode: target.exitCode,
      durationMs: target.durationMs,
      ...(target.error === undefined ? {} : { error: target.error }),
    })),
    ...(run.children === undefined ? {} : {
      steps: run.children.map(child => ({
        taskName: child.taskName,
        status: child.status,
        ...(child.runId === undefined ? {} : { runId: child.runId }),
      })),
    }),
  }
}

/**
 * POST one finished run to the configured webhook.
 * @param settings - workspace notification settings.
 * @param run - the finished run.
 * @param fetchImpl - fetch implementation (tests inject one).
 * @returns sent/error; never throws.
 */
export async function sendRunWebhook(
  settings: OpsSettings,
  run: OpsRun,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  if (!shouldNotify(settings, run)) return { sent: false }
  const url = settings.webhookUrl
  if (url === undefined) return { sent: false }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 5_000)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(run)),
      signal: controller.signal,
    })
    if (!response.ok) return { sent: false, error: `webhook responded ${response.status}` }
    return { sent: true }
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
