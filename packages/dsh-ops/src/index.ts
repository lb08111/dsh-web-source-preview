/**
 * dsh-ops — host half.
 *
 * Mounts the definitions ledger, the run store, the task runner, the
 * /api/dsh-ops route family and the agent tools. The SSH transport is injected
 * from dsh-ssh (`sshTransport`): this package never imports the SSH engine.
 *
 * The AI authoring loop uses the native DSH conversation: tools let an agent
 * read the tree, write a task draft, and run it only after an explicit
 * confirmation.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { mountOnce } from './mount-once.ts'
import { OpsStore } from './store.ts'
import { RunStore } from './runs.ts'
import { TaskRunner } from './runner.ts'
import { TaskScheduler } from './scheduler.ts'
import { PanelBus } from './panel-bus.ts'
import { makeOpsRoutes } from './routes.ts'
import { buildOpsTools } from './tools.ts'
import type { OpsTransport } from './transport.ts'
import { PLUGIN_TOOL_SECTION_ORDERS, visibleToolText } from './tool-surface.ts'

/** Stable cordis plugin name. */
export const name = 'ops'

/** Services required before the workspace can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'sshTransport'] as const

/** Plugin config. */
export interface Config {
  /** Master switch for routes, tools and the announcement. */
  enabled?: boolean
  /** When true, a prompt section announces the workspace to every agent. */
  announceToAgent?: boolean
}

/** Plugin config schema (also the settings page). */
export const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
})

/** Model-facing announcement: presence, workflow and limits. */
export const OPS_GUIDANCE = '本机已安装 dsh-ops 插件（测试管理平台）：侧边栏「测试管理平台」入口，卡片式管理台（系统 → 服务 → 服务器 → 任务，逐级卡片下钻）；SSH 运维仍是侧边栏独立入口（主机 / 终端 / 文件传输 / 隧道 / 集群）。能力：系统 → 服务 → 服务器 → 任务的树，每级都能新建；任务 = bash 脚本 + 参数 + 目标，默认一条定义应用到该服务的所有服务器，可用单服务器覆盖参数；服务器仓库就是 dsh-ssh 的主机配置（支持分组/标签、CSV 与 ~/.ssh/config 导入、直接新增用户名密码）；任务通过 bash -s 的 stdin 执行，参数以环境变量注入，文件参数先上传到 /tmp/dsh-ops/<run>/ 再把远端路径传进去。Agent 工具：ops_tree 读树、ops_repo 列出服务器仓库、ops_system_save 建/改系统、ops_service_save 建/改服务、ops_server_save 建/改服务器、ops_delete 删除（必须 confirm:true）、ops_task_get 读任务、ops_task_save 建/改任务（不执行）、ops_task_run 运行（必须由用户明确要求并传 confirm:true）、ops_run_status 查运行、ops_run_log 读日志、ops_settings 读写 Webhook 通知设置、ops_panel 在用户浏览器里打开运维面板并定位到某个节点（只切换界面，不改数据）。AI 建环境：用户说「帮我建一个系统…」时，先确认系统名、服务名、每台服务器的仓库别名或新主机信息（缺的可以问，不要猜），再依次 ops_system_save → ops_service_save → ops_server_save；服务器别名先用 ops_repo 查仓库，不要在聊天里索要密码，除非用户主动提供；建完用 ops_panel 打开给用户看。AI 写脚本的正确流程：先用 ssh_exec 连上目标服务器探测进程/端口/目录/配置，再写脚本并用 ops_task_save 保存；不要凭空猜路径。限制：平台不做构建与 CI；命令输出原样返回、可能含敏感信息；destructive 任务必须人工确认；运行会真实改动服务器。用户提到「测试管理平台 / 测试环境 / 运维 / 服务器 / 应用 / 服务 / 任务 / SSH / 发布脚本 / 启停脚本」时即指本插件，请据此协作。'

/** Tool names the announcement describes. */
const TOOL_NAMES = ['ops_tree', 'ops_repo', 'ops_system_save', 'ops_service_save', 'ops_server_save', 'ops_delete', 'ops_task_get', 'ops_task_save', 'ops_task_run', 'ops_run_status', 'ops_run_log', 'ops_settings', 'ops_panel'] as const

/** Section order between the SSH band (150) and the task board (200). */
const SECTION_ORDER = PLUGIN_TOOL_SECTION_ORDERS.ops

/** Mount the workspace. */
export const apply = mountOnce('@linxin666/dsh-ops', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const transport = (ctx as unknown as { sshTransport?: OpsTransport }).sshTransport
  if (transport === undefined) {
    throw new Error('dsh-ops requires the sshTransport service from dsh-ssh')
  }
  const store = new OpsStore()
  const runs = new RunStore()
  const runner = new TaskRunner(store, runs, transport)
  const scheduler = new TaskScheduler(store, runner)
  if (config?.enabled !== false) scheduler.start()
  ctx.effect(() => () => {
    scheduler.stop()
    runner.dispose()
  }, 'dsh-ops: runner')

  const panel = new PanelBus()
  const routes = makeOpsRoutes({ store, runs, runner, transport, panel })
  const tools = buildOpsTools(store, runs, runner, panel, transport)

  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (config?.enabled === false) return

    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ops: routes',
    )

    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ops: tools',
    )

    if (config?.announceToAgent === true) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-ops',
        order: SECTION_ORDER,
        text: visibleToolText(ctx.tools, TOOL_NAMES, OPS_GUIDANCE),
      })
    }
  }

  sync()
}
