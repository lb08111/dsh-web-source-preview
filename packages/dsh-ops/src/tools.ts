/**
 * Agent tools for the ops workspace.
 *
 * The AI authoring loop uses the native DSH conversation: the agent reads the
 * tree, inspects a server through dsh-ssh's `ssh_exec`, proposes a script, and
 * writes it back with `ops_task_save`. Execution is a separate, explicit step
 * (`ops_task_run` with `confirm: true`) so drafting never runs anything.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { NewHostInput, OpsServer, OpsService, OpsSystem, OpsTask, RunStatus, RuntimeSpec, TaskRisk } from './protocol.ts'
import type { TaskRunner } from './runner.ts'
import type { PanelBus } from './panel-bus.ts'
import { addServerWithTemplates } from './server-create.ts'
import type { RunStore } from './runs.ts'
import type { OpsStore } from './store.ts'
import type { OpsTransport } from './transport.ts'

/** One text content block. */
function systemSummary(system: OpsSystem): { id: string; name: string; description?: string; color?: string } {
  return {
    id: system.id,
    name: system.name,
    ...(system.description === undefined ? {} : { description: system.description }),
    ...(system.color === undefined ? {} : { color: system.color }),
  }
}

function serviceSummary(service: OpsService): { id: string; systemId: string; name: string; description?: string; color?: string } {
  return {
    id: service.id,
    systemId: service.systemId,
    name: service.name,
    ...(service.description === undefined ? {} : { description: service.description }),
    ...(service.color === undefined ? {} : { color: service.color }),
  }
}

function serverSummary(server: OpsServer): {
  id: string
  serviceId: string
  sshAlias: string
  name: string
  environment?: string
  color?: string
  runtime: { kind: string; unit?: string; workdir?: string; port?: number; composeFile?: string }
} {
  const runtime: { kind: string; unit?: string; workdir?: string; port?: number; composeFile?: string } = { kind: server.runtime.kind }
  if (server.runtime.unit !== undefined) runtime.unit = server.runtime.unit
  if (server.runtime.workdir !== undefined) runtime.workdir = server.runtime.workdir
  if (server.runtime.port !== undefined) runtime.port = server.runtime.port
  if (server.runtime.composeFile !== undefined) runtime.composeFile = server.runtime.composeFile
  return {
    id: server.id,
    serviceId: server.serviceId,
    sshAlias: server.sshAlias,
    name: server.name,
    runtime,
    ...(server.environment === undefined ? {} : { environment: server.environment }),
    ...(server.color === undefined ? {} : { color: server.color }),
  }
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Compact task line for the tree render. */
function taskLine(task: OpsTask): string {
  const scope = task.scope === 'single' ? 'single' : 'all'
  return `${task.id} | ${task.name} | ${task.owner.kind}:${task.owner.id} | ${scope} | ${task.risk}`
}

/** Status glyph. */
function statusGlyph(status: RunStatus): string {
  if (status === 'ok') return 'ok'
  if (status === 'failed') return 'failed'
  if (status === 'partial') return 'partial'
  if (status === 'running') return 'running'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'skipped') return 'skipped'
  return 'queued'
}

/** Build every ops tool. */
export function buildOpsTools(store: OpsStore, runs: RunStore, runner: TaskRunner, panel: PanelBus, transport: OpsTransport) {
  const treeTool = defineTool({
    name: 'ops_tree',
    description: 'Read the ops workspace tree: systems, services, servers (SSH alias references) and task definitions. Use this before proposing, editing or running a task. Task ids from this tool are what ops_task_get / ops_task_save / ops_task_run take.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against system, service, server and task names.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'integer', required: true },
          systems: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          services: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                systemId: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                serviceId: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                name: { type: 'string', required: true },
                runtime: { type: 'string', required: true },
                workdir: { type: 'string' },
                port: { type: 'integer' },
              },
            },
          },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                ownerKind: { type: 'string', required: true },
                ownerId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                risk: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: {
        revision: number
        systems: Array<{ id: string; name: string }>
        services: Array<{ id: string; name: string; systemId: string }>
        servers: Array<{ id: string; alias: string; serviceId: string; runtime: string }>
        tasks: Array<{ id: string; name: string; ownerKind: string; ownerId: string; kind: string; scope: string; risk: string }>
      }) => {
        const systems = value.systems.map(entry => `${entry.id} | ${entry.name}`)
        const services = value.services.map(entry => `${entry.id} | ${entry.name} | system:${entry.systemId}`)
        const servers = value.servers.map(entry => `${entry.id} | ${entry.alias} | service:${entry.serviceId} | ${entry.runtime}`)
        const tasks = value.tasks.map(entry => `${entry.id} | ${entry.name} | ${entry.ownerKind}:${entry.ownerId} | ${entry.kind} | ${entry.scope} | ${entry.risk}`)
        return text([
          `revision ${value.revision}`,
          '',
          'systems:', ...(systems.length > 0 ? systems : ['(none)']),
          '',
          'services:', ...(services.length > 0 ? services : ['(none)']),
          '',
          'servers:', ...(servers.length > 0 ? servers : ['(none)']),
          '',
          'tasks:', ...(tasks.length > 0 ? tasks : ['(none)']),
        ].join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const snapshot = store.snapshot()
      const needle = args.query?.trim().toLowerCase()
      const match = (values: string[]): boolean => needle === undefined || needle === ''
        || values.some(value => value.toLowerCase().includes(needle))
      return {
        revision: snapshot.revision,
        systems: snapshot.systems.filter(entry => match([entry.id, entry.name])).map(entry => ({ id: entry.id, name: entry.name })),
        services: snapshot.services.filter(entry => match([entry.id, entry.name])).map(entry => ({ id: entry.id, systemId: entry.systemId, name: entry.name })),
        servers: snapshot.servers
          .filter(entry => match([entry.id, entry.sshAlias, entry.name, entry.environment ?? '']))
          .map(entry => ({
            id: entry.id,
            serviceId: entry.serviceId,
            alias: entry.sshAlias,
            name: entry.name,
            runtime: entry.runtime.kind,
            ...(entry.runtime.workdir === undefined ? {} : { workdir: entry.runtime.workdir }),
            ...(entry.runtime.port === undefined ? {} : { port: entry.runtime.port }),
          })),
        tasks: snapshot.tasks
          .filter(entry => match([entry.id, entry.name, entry.description ?? '']))
          .map(entry => ({
            id: entry.id,
            name: entry.name,
            ownerKind: entry.owner.kind,
            ownerId: entry.owner.id,
            kind: entry.kind,
            scope: entry.scope,
            risk: entry.risk,
          })),
      }
    },
  })

  const taskGetTool = defineTool({
    name: 'ops_task_get',
    description: 'Read one task definition in full: shell script, parameters, environment, timeout, risk, target scope and per-server overrides.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id from ops_tree.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              description: { type: 'string' },
              ownerKind: { type: 'string', required: true },
              ownerId: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              scope: { type: 'string', required: true },
              serverId: { type: 'string' },
              risk: { type: 'string', required: true },
              timeoutMs: { type: 'integer', required: true },
              cwd: { type: 'string' },
              script: { type: 'string', required: true },
              failure: { type: 'string' },
              schedule: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  enabled: { type: 'boolean', required: true },
                  cron: { type: 'string', required: true },
                  timeZone: { type: 'string' },
                  lastRunAt: { type: 'integer' },
                },
              },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    mode: { type: 'string', required: true },
                    params: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          name: { type: 'string', required: true },
                          value: { type: 'string', required: true },
                        },
                      },
                    },
                    serverIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              params: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    type: { type: 'string', required: true },
                    required: { type: 'boolean' },
                    default: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    description: { type: 'string' },
                  },
                },
              },
              env: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    value: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value: {
        ok: boolean
        error?: string
        task?: {
          id: string
          name: string
          ownerKind: string
          ownerId: string
          kind: string
          scope: string
          serverId?: string
          risk: string
          timeoutMs: number
          script: string
          failure?: string
          schedule?: { enabled: boolean; cron: string; timeZone?: string; lastRunAt?: number }
          steps?: Array<{ id: string; taskId: string; mode: string }>
          params: Array<{ name: string; type: string; required?: boolean; default?: string; options?: string[]; description?: string }>
        }
      }) => {
        if (!value.ok || value.task === undefined) return text(`task not found: ${value.error ?? 'unknown'}`)
        const task = value.task
        const params = task.params.length === 0
          ? '  (none)'
          : task.params.map(param => `  ${param.name} (${param.type}${param.required === true ? ', required' : ''}${param.default === undefined ? '' : `, default=${param.default}`})`).join('\n')
        if (task.kind === 'flow') {
          const steps = (task.steps ?? []).map((step, index) => `${index + 1}. ${step.taskId} [${step.mode}]`)
          return text([
            `${task.id} | ${task.name} | flow`,
            `owner: ${task.ownerKind}:${task.ownerId} · failure: ${task.failure ?? 'stop'}`,
            '',
            'steps:',
            ...(steps.length > 0 ? steps : ['  (none)']),
          ].join('\n'))
        }
        return text([
          `${task.id} | ${task.name}`,
          `owner: ${task.ownerKind}:${task.ownerId} · scope: ${task.scope}${task.serverId === undefined ? '' : ` (${task.serverId})`}`,
          `risk: ${task.risk} · timeout: ${task.timeoutMs}ms`,
          `schedule: ${task.schedule === undefined ? '(none)' : `${task.schedule.enabled ? 'on' : 'off'} · ${task.schedule.cron}${task.schedule.timeZone === undefined ? '' : ` · ${task.schedule.timeZone}`}`}`,
          '',
          'params:',
          params,
          '',
          'script:',
          task.script,
        ].join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const task = store.task(args.taskId)
      if (task === undefined) return { ok: false, error: `task '${args.taskId}' not found` }
      return {
        ok: true,
        task: {
          id: task.id,
          name: task.name,
          ...(task.description === undefined ? {} : { description: task.description }),
          ownerKind: task.owner.kind,
          ownerId: task.owner.id,
          kind: task.kind,
          scope: task.scope,
          ...(task.serverId === undefined ? {} : { serverId: task.serverId }),
          risk: task.risk,
          timeoutMs: task.timeoutMs,
          ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
          script: task.script,
          params: task.params.map(param => ({
            name: param.name,
            type: param.type,
            ...(param.required === undefined ? {} : { required: param.required }),
            ...(param.default === undefined ? {} : { default: param.default }),
            ...(param.options === undefined ? {} : { options: param.options }),
            ...(param.description === undefined ? {} : { description: param.description }),
          })),
          env: Object.entries(task.env).map(([name, value]) => ({ name, value })),
          ...(task.schedule === undefined ? {} : {
            schedule: {
              enabled: task.schedule.enabled,
              cron: task.schedule.cron,
              ...(task.schedule.timeZone === undefined ? {} : { timeZone: task.schedule.timeZone }),
              ...(task.schedule.lastRunAt === undefined ? {} : { lastRunAt: task.schedule.lastRunAt }),
            },
          }),
          ...(task.kind === 'flow'
            ? {
                failure: task.failure ?? 'stop',
                steps: (task.steps ?? []).map(step => ({
                  id: step.id,
                  taskId: step.taskId,
                  mode: step.mode,
                  ...(step.params === undefined ? {} : {
                    params: Object.entries(step.params).map(([name, value]) => ({ name, value })),
                  }),
                  ...(step.serverIds === undefined ? {} : { serverIds: step.serverIds }),
                })),
              }
            : {}),
        },
      }
    },
  })

  const taskSaveTool = defineTool({
    name: 'ops_task_save',
    description: 'Create or update a task definition in the ops workspace. This only saves the script and its parameters; it never runs anything. Pass id to update an existing task, or ownerKind+ownerId to create a new one. Prefer reading the server first with ssh_exec so the script matches its real runtime, paths and ports.',
    parameters: {
      id: { type: 'string', description: 'Existing task id to update (omit to create).' },
      ownerKind: { type: 'string', enum: ['service', 'system'], description: 'Owner kind for a new task.' },
      ownerId: { type: 'string', description: 'Owner id for a new task (service or system id from ops_tree).' },
      name: { type: 'string', description: 'Task name (required when creating).' },
      description: { type: 'string' },
      kind: { type: 'string', enum: ['script', 'flow'], description: 'script (default) or flow (ordered chain of script tasks).' },
      script: { type: 'string', description: 'Bash script body; executed through `bash -s` on stdin.' },
      failure: { type: 'string', enum: ['stop', 'continue'], description: 'Flow failure policy (default stop).' },
      schedule: {
        type: 'object',
        additionalProperties: false,
        description: 'Cron schedule. Pass the full object (enabled + cron [+ timeZone]); omit to leave it unchanged.',
        properties: {
          enabled: { type: 'boolean' },
          cron: { type: 'string' },
          timeZone: { type: 'string' },
        },
      },
      steps: {
        type: 'array',
        description: 'Flow steps (replaces the existing list when updating).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            mode: { type: 'string', enum: ['serial', 'parallel'] },
            params: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                },
              },
            },
            serverIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      timeoutMs: { type: 'integer' },
      risk: { type: 'string', enum: ['read', 'write', 'destructive'] },
      scope: { type: 'string', enum: ['all', 'single'] },
      serverId: { type: 'string', description: 'Target server id when scope is single.' },
      cwd: { type: 'string' },
      params: {
        type: 'array',
        description: 'Full parameter list to store (replaces the existing list when updating).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            type: { type: 'string', required: true, enum: ['text', 'number', 'boolean', 'select', 'file'] },
            required: { type: 'boolean' },
            default: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            label: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      env: {
        type: 'array',
        description: 'Environment variables to store (replaces the existing map when updating).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          name: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; taskId?: string; name?: string; error?: string }) => text(value.ok
        ? `saved task ${value.taskId} (${value.name})`
        : `save failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        if (args.id !== undefined && args.id !== '') {
          const existing = store.task(args.id)
          if (existing === undefined) throw new Error(`task '${args.id}' not found`)
          const updated = store.updateTask(args.id, {
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.script === undefined ? {} : { script: args.script }),
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            ...(args.risk === undefined ? {} : { risk: args.risk as TaskRisk }),
            ...(args.scope === undefined ? {} : { scope: args.scope }),
            ...(args.serverId === undefined ? {} : { serverId: args.serverId }),
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(args.params === undefined ? {} : { params: args.params }),
            ...(args.env === undefined ? {} : { env: Object.fromEntries(args.env.map(entry => [entry.name, entry.value])) }),
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(args.failure === undefined ? {} : { failure: args.failure }),
            ...(args.schedule === undefined ? {} : { schedule: {
              enabled: args.schedule.enabled !== false,
              cron: args.schedule.cron ?? existing.schedule?.cron ?? '',
              ...(args.schedule.timeZone === undefined && existing.schedule?.timeZone === undefined
                ? {}
                : { timeZone: args.schedule.timeZone ?? existing.schedule?.timeZone }),
            } }),
            ...(args.steps === undefined ? {} : { steps: args.steps.map(step => ({
              taskId: step.taskId,
              mode: step.mode,
              ...(step.params === undefined ? {} : { params: Object.fromEntries(step.params.map(entry => [entry.name, entry.value])) }),
              ...(step.serverIds === undefined ? {} : { serverIds: step.serverIds }),
            })) }),
          })
          return { ok: true, taskId: updated.id, name: updated.name }
        }
        if (args.ownerKind === undefined || args.ownerId === undefined || args.name === undefined) {
          throw new Error('ownerKind, ownerId and name are required when creating a task')
        }
        if (args.kind !== 'flow' && args.script === undefined) {
          throw new Error('script is required when creating a script task')
        }
        const created = store.createTask({
          owner: { kind: args.ownerKind, id: args.ownerId },
          name: args.name,
          description: args.description,
          kind: args.kind,
          script: args.script ?? '',
          failure: args.failure,
          ...(args.schedule === undefined ? {} : { schedule: {
            enabled: args.schedule.enabled !== false,
            cron: args.schedule.cron ?? '',
            ...(args.schedule.timeZone === undefined ? {} : { timeZone: args.schedule.timeZone }),
          } }),
          steps: args.steps?.map(step => ({
            taskId: step.taskId,
            mode: step.mode,
            ...(step.params === undefined ? {} : { params: Object.fromEntries(step.params.map(entry => [entry.name, entry.value])) }),
            ...(step.serverIds === undefined ? {} : { serverIds: step.serverIds }),
          })),
          timeoutMs: args.timeoutMs,
          risk: args.risk as TaskRisk | undefined,
          scope: args.scope,
          serverId: args.serverId,
          cwd: args.cwd,
          params: args.params,
          env: args.env === undefined ? undefined : Object.fromEntries(args.env.map(entry => [entry.name, entry.value])),
        })
        return { ok: true, taskId: created.id, name: created.name }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const taskRunTool = defineTool({
    name: 'ops_task_run',
    description: 'Run one saved task on its target servers. Execution changes real servers, so `confirm: true` is required and must only be passed after the user explicitly asked to run it. Use ops_run_status / ops_run_log to follow it.',
    parameters: {
      taskId: { type: 'string', required: true },
      params: {
        type: 'array',
        description: 'Parameter values as name/value pairs.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
      },
      confirm: { type: 'boolean', required: true, description: 'Must be true; confirms the user asked to run this task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          runId: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; runId?: string; status?: string; error?: string }) => text(value.ok
        ? `run started: ${value.runId} (${value.status})`
        : `run refused: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: 'confirm must be true; only run after the user explicitly asked' }
      try {
        const params = Object.fromEntries((args.params ?? []).map(entry => [entry.name, entry.value]))
        const run = await runner.start(args.taskId, { params, source: 'agent' })
        return { ok: true, runId: run.id, status: run.status }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const runStatusTool = defineTool({
    name: 'ops_run_status',
    description: 'Read one run: overall status, parameters, and every target server with exit code, duration and error.',
    parameters: {
      runId: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          run: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              taskId: { type: 'string', required: true },
              taskName: { type: 'string', required: true },
              status: { type: 'string', required: true },
              startedAt: { type: 'integer', required: true },
              endedAt: { type: 'integer' },
              targets: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    serverId: { type: 'string', required: true },
                    alias: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                    durationMs: { type: 'integer', required: true },
                    error: { type: 'string' },
                  },
                },
              },
              children: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    stepId: { type: 'string', required: true },
                    taskId: { type: 'string', required: true },
                    taskName: { type: 'string', required: true },
                    runId: { type: 'string' },
                    status: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value: {
        ok: boolean
        error?: string
        run?: {
          id: string
          taskName: string
          status: string
          targets: Array<{ alias: string; status: string; exitCode: number | null; durationMs: number; error?: string }>
          children?: Array<{ taskName: string; status: string; runId?: string }>
        }
      }) => {
        if (!value.ok || value.run === undefined) return text(`run not found: ${value.error ?? 'unknown'}`)
        if (value.run.children !== undefined && value.run.children.length > 0) {
          const steps = value.run.children.map((child, index) =>
            `${index + 1}. ${child.taskName}: ${statusGlyph(child.status as RunStatus)}${child.runId === undefined ? '' : ` (${child.runId})`}`)
          return text(`${value.run.id} · ${value.run.taskName} · ${value.run.status}\n${steps.join('\n')}`)
        }
        const lines = value.run.targets.map(target =>
          `${target.alias}: ${statusGlyph(target.status as RunStatus)} [exit ${target.exitCode ?? 'null'}] ${target.durationMs}ms${target.error === undefined ? '' : ` (${target.error})`}`)
        return text(`${value.run.id} · ${value.run.taskName} · ${value.run.status}\n${lines.join('\n')}`)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const run = runs.get(args.runId)
      if (run === undefined) return { ok: false, error: `run '${args.runId}' not found` }
      return {
        ok: true,
        run: {
          id: run.id,
          taskId: run.taskId,
          taskName: run.taskName,
          status: run.status,
          startedAt: run.startedAt,
          ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          targets: run.targets.map(target => ({
            serverId: target.serverId,
            alias: target.alias,
            status: target.status,
            exitCode: target.exitCode,
            durationMs: target.durationMs,
            ...(target.error === undefined ? {} : { error: target.error }),
          })),
          ...(run.children === undefined ? {} : {
            children: run.children.map(child => ({
              stepId: child.stepId,
              taskId: child.taskId,
              taskName: child.taskName,
              status: child.status,
              ...(child.runId === undefined ? {} : { runId: child.runId }),
            })),
          }),
        },
      }
    },
  })

  const runLogTool = defineTool({
    name: 'ops_run_log',
    description: 'Read the log tail of one target inside a run (stdout and stderr of the script). For a flow run, omit serverId to read the step summary log, or pass a child run id as runId.',
    parameters: {
      runId: { type: 'string', required: true },
      serverId: { type: 'string', description: 'Target server id. Omit on a flow run to read its step summary.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; text?: string; error?: string }) => text(value.ok
        ? (value.text === '' ? 'log is empty' : value.text ?? '')
        : `log unavailable: ${value.error ?? 'unknown'}`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const run = runs.get(args.runId)
      if (run === undefined) return { ok: false, error: `run '${args.runId}' not found` }
      if (args.serverId === undefined || args.serverId === '') {
        if (run.children === undefined) return { ok: false, error: 'serverId is required for a script run' }
        return { ok: true, text: runs.readLog(args.runId, 'flow', 32 * 1024) }
      }
      if (!run.targets.some(target => target.serverId === args.serverId)) {
        return { ok: false, error: `server '${args.serverId}' is not a target of this run` }
      }
      return { ok: true, text: runs.readLog(args.runId, args.serverId, 32 * 1024) }
    },
  })

  const settingsTool = defineTool({
    name: 'ops_settings',
    description: 'Read or update workspace notification settings. With no arguments it reads them; pass webhookUrl and/or webhookOn to update. A finished run posts one JSON document to the webhook (no command output, no credentials).',
    parameters: {
      webhookUrl: { type: 'string', description: 'HTTP(S) endpoint; an empty string turns notifications off.' },
      webhookOn: { type: 'string', enum: ['always', 'failure'], description: 'Send on every finished run, or only on failures.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          settings: {
            type: 'object',
            additionalProperties: false,
            properties: {
              webhookUrl: { type: 'string' },
              webhookOn: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; settings?: { webhookUrl?: string; webhookOn: string } }) => text(value.ok && value.settings !== undefined
        ? `webhook: ${value.settings.webhookUrl ?? '(off)'} · on ${value.settings.webhookOn}`
        : `settings unavailable: ${value.error ?? 'unknown'}`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const settings = args.webhookUrl === undefined && args.webhookOn === undefined
          ? store.settings()
          : store.updateSettings({
              ...(args.webhookUrl === undefined ? {} : { webhookUrl: args.webhookUrl }),
              ...(args.webhookOn === undefined ? {} : { webhookOn: args.webhookOn }),
            })
        return {
          ok: true,
          settings: {
            ...(settings.webhookUrl === undefined ? {} : { webhookUrl: settings.webhookUrl }),
            webhookOn: settings.webhookOn,
          },
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const panelTool = defineTool({
    name: 'ops_panel',
    description: 'Bring the ops panel to a node in the user browser: opens the panel (switching the center column to it), refreshes its data, and selects a system/service/server/task/run. UI only: it never changes data and never runs anything. Use after creating or changing a task, or when the user asks to see something in the panel.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'select', 'refresh'], description: 'open/select show the node; refresh only reloads the panel.' },
      kind: { type: 'string', enum: ['root', 'system', 'service', 'server', 'task', 'run'], description: 'Node kind to show (omit for refresh).' },
      id: { type: 'string', description: 'Node id from ops_tree / ops_run_status (omit for root).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          seq: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; seq?: number; error?: string }) => text(value.ok
        ? `panel command queued (#${value.seq ?? '?'})`
        : `panel command refused: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.action === 'refresh') {
        return { ok: true, seq: panel.push('refresh') }
      }
      const kind = args.kind
      if (kind === undefined) return { ok: false, error: 'kind is required unless action is refresh' }
      if (kind !== 'root' && (args.id === undefined || args.id === '')) {
        return { ok: false, error: `id is required for ${kind}` }
      }
      const snapshot = store.snapshot()
      const id = args.id ?? ''
      const exists = kind === 'root'
        || (kind === 'system' && snapshot.systems.some(entry => entry.id === id))
        || (kind === 'service' && snapshot.services.some(entry => entry.id === id))
        || (kind === 'server' && snapshot.servers.some(entry => entry.id === id))
        || (kind === 'task' && snapshot.tasks.some(entry => entry.id === id))
        || (kind === 'run' && runs.get(id) !== undefined)
      if (!exists) return { ok: false, error: `${kind} '${id}' not found` }
      return { ok: true, seq: panel.push(args.action, kind === 'root' ? { kind } : { kind, id }) }
    },
  })

  const systemSaveTool = defineTool({
    name: 'ops_system_save',
    description: 'Create or update a system definition. Pass id to update, or name to create. Systems are the top of the hierarchy (system -> service -> server -> task).',
    parameters: {
      id: { type: 'string', description: 'Existing system id to update (omit to create).' },
      name: { type: 'string', description: 'System name (required when creating).' },
      description: { type: 'string' },
      color: { type: 'string', description: 'Card accent as #rrggbb.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          system: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              description: { type: 'string' },
              color: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; system?: { id: string; name: string } }) => text(value.ok && value.system !== undefined
        ? `saved system ${value.system.id} (${value.system.name})`
        : `system save failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        if (args.id !== undefined && args.id !== '') {
          const updated = store.updateSystem(args.id, {
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.color === undefined ? {} : { color: args.color }),
          })
          return { ok: true, system: systemSummary(updated) }
        }
        if (args.name === undefined || args.name.trim() === '') {
          return { ok: false, error: 'name is required when creating a system' }
        }
        const created = store.createSystem({
          name: args.name,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.color === undefined ? {} : { color: args.color }),
        })
        return { ok: true, system: systemSummary(created) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const serviceSaveTool = defineTool({
    name: 'ops_service_save',
    description: 'Create or update a service under a system. Pass id to update, or systemId + name to create. Servers and tasks hang off the service.',
    parameters: {
      id: { type: 'string', description: 'Existing service id to update (omit to create).' },
      systemId: { type: 'string', description: 'Owning system id (required when creating).' },
      name: { type: 'string', description: 'Service name (required when creating).' },
      description: { type: 'string' },
      color: { type: 'string', description: 'Card accent as #rrggbb; falls back to the system.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          service: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              systemId: { type: 'string', required: true },
              name: { type: 'string', required: true },
              description: { type: 'string' },
              color: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; service?: { id: string; name: string } }) => text(value.ok && value.service !== undefined
        ? `saved service ${value.service.id} (${value.service.name})`
        : `service save failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        if (args.id !== undefined && args.id !== '') {
          const updated = store.updateService(args.id, {
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.color === undefined ? {} : { color: args.color }),
          })
          return { ok: true, service: serviceSummary(updated) }
        }
        if (args.systemId === undefined || args.systemId === '') {
          return { ok: false, error: 'systemId is required when creating a service' }
        }
        if (args.name === undefined || args.name.trim() === '') {
          return { ok: false, error: 'name is required when creating a service' }
        }
        const created = store.createService({
          systemId: args.systemId,
          name: args.name,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.color === undefined ? {} : { color: args.color }),
        })
        return { ok: true, service: serviceSummary(created) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const runtimeKind = { type: 'string', enum: ['systemd', 'compose', 'docker', 'supervisor', 'custom'] } as const
  const runtimeSchema = {
    type: 'object',
    additionalProperties: false,
    description: 'How the application is supervised on the host.',
    properties: {
      kind: { ...runtimeKind, required: true },
      unit: { type: 'string' },
      workdir: { type: 'string' },
      port: { type: 'integer' },
      composeFile: { type: 'string' },
    },
  } as const

  const serverSaveTool = defineTool({
    name: 'ops_server_save',
    description: 'Create or update a server under a service. To create, pass serviceId plus either sshAlias (a host already in the dsh-ssh repository) or newHost (create the host inline). runtime is required on create. Starter start/stop/restart/status/publish tasks are generated once per service unless generateTemplates is false. Prefer sshAlias: use ops_repo to list repository hosts, and never ask the user to paste a password in chat unless they offered it.',
    parameters: {
      id: { type: 'string', description: 'Existing server id to update (omit to create).' },
      serviceId: { type: 'string', description: 'Owning service id (required when creating).' },
      sshAlias: { type: 'string', description: 'Repository host alias (create mode).' },
      newHost: {
        type: 'object',
        additionalProperties: false,
        description: 'Inline host creation (create mode); only when the user supplied credentials.',
        properties: {
          alias: { type: 'string', required: true },
          host: { type: 'string', required: true },
          port: { type: 'integer' },
          user: { type: 'string', required: true },
          auth: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kind: { type: 'string', required: true, enum: ['key', 'password', 'agent'] },
              keyPath: { type: 'string' },
              passphrase: { type: 'string' },
              password: { type: 'string' },
              agentPath: { type: 'string' },
            },
          },
          group: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
      },
      name: { type: 'string', description: 'Display name (defaults to the alias).' },
      environment: { type: 'string', description: 'Logical group; defaults to the repository host group.' },
      runtime: runtimeSchema,
      color: { type: 'string', description: 'Card accent as #rrggbb; falls back to the service.' },
      generateTemplates: { type: 'boolean', description: 'Generate starter tasks (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          tasks: { type: 'integer' },
          server: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              serviceId: { type: 'string', required: true },
              sshAlias: { type: 'string', required: true },
              name: { type: 'string', required: true },
              environment: { type: 'string' },
              color: { type: 'string' },
              runtime: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  unit: { type: 'string' },
                  workdir: { type: 'string' },
                  port: { type: 'integer' },
                  composeFile: { type: 'string' },
                },
              },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; tasks?: number; server?: { id: string; sshAlias: string } }) => text(value.ok && value.server !== undefined
        ? `saved server ${value.server.id} (${value.server.sshAlias})${value.tasks === undefined || value.tasks === 0 ? '' : ` + ${value.tasks} starter task(s)`}`
        : `server save failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        if (args.id !== undefined && args.id !== '') {
          const updated = store.updateServer(args.id, {
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.environment === undefined ? {} : { environment: args.environment }),
            ...(args.runtime === undefined ? {} : { runtime: args.runtime as RuntimeSpec }),
            ...(args.color === undefined ? {} : { color: args.color }),
          })
          return { ok: true, server: serverSummary(updated), tasks: 0 }
        }
        if (args.serviceId === undefined || args.serviceId === '') {
          return { ok: false, error: 'serviceId is required when creating a server' }
        }
        if (args.runtime === undefined) {
          return { ok: false, error: 'runtime is required when creating a server' }
        }
        if ((args.sshAlias === undefined || args.sshAlias === '') && args.newHost === undefined) {
          return { ok: false, error: 'sshAlias or newHost is required when creating a server' }
        }
        const created = addServerWithTemplates(store, transport, {
          serviceId: args.serviceId,
          ...(args.sshAlias === undefined || args.sshAlias === '' ? {} : { sshAlias: args.sshAlias }),
          ...(args.newHost === undefined ? {} : { newHost: args.newHost as NewHostInput }),
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.environment === undefined ? {} : { environment: args.environment }),
          runtime: args.runtime as RuntimeSpec,
          ...(args.color === undefined ? {} : { color: args.color }),
          ...(args.generateTemplates === undefined ? {} : { generateTemplates: args.generateTemplates }),
        })
        return { ok: true, server: serverSummary(created.server), tasks: created.tasks }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const deleteTool = defineTool({
    name: 'ops_delete',
    description: 'Delete a system, service, server or task. Destructive and cascading (a system deletes its services/servers/tasks; a service deletes its servers/tasks). Requires confirm: true and must only be used after the user explicitly asked to delete it.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['system', 'service', 'server', 'task'] },
      id: { type: 'string', required: true },
      confirm: { type: 'boolean', required: true, description: 'Must be true; confirms the user asked for this deletion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; error?: string }) => text(value.ok ? 'deleted' : `delete refused: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: 'confirm must be true; only delete after the user explicitly asked' }
      try {
        if (args.kind === 'system') store.deleteSystem(args.id)
        else if (args.kind === 'service') store.deleteService(args.id)
        else if (args.kind === 'server') store.deleteServer(args.id)
        else store.deleteTask(args.id)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const repoTool = defineTool({
    name: 'ops_repo',
    description: 'List the dsh-ssh server repository (the hosts a server can reference). Use this to pick sshAlias values before calling ops_server_save instead of guessing aliases. Secrets are never returned.',
    parameters: {
      query: { type: 'string', description: 'Optional filter over alias/host/user/group/tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          hosts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', required: true },
                group: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; hosts?: Array<{ alias: string; host: string; user: string; group?: string }> }) => text(value.ok && value.hosts !== undefined
        ? (value.hosts.length === 0 ? 'repository is empty' : value.hosts.map(host => `${host.alias} | ${host.user}@${host.host}${host.group === undefined ? '' : ` | ${host.group}`}`).join('\n'))
        : `repository unavailable: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const needle = args.query?.trim().toLowerCase()
        const hosts = transport.list()
          .filter(host => needle === undefined || needle === ''
            || [host.alias, host.host, host.user, host.environment ?? '', ...host.tags].some(value => value.toLowerCase().includes(needle)))
          .map(host => ({
            alias: host.alias,
            host: host.host,
            port: host.port,
            user: host.user,
            auth: host.auth,
            ...(host.environment === undefined ? {} : { group: host.environment }),
            tags: host.tags,
            ...(host.description === undefined ? {} : { description: host.description }),
          }))
        return { ok: true, hosts }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  return [treeTool, taskGetTool, taskSaveTool, taskRunTool, runStatusTool, runLogTool, settingsTool, panelTool, systemSaveTool, serviceSaveTool, serverSaveTool, deleteTool, repoTool]
}
