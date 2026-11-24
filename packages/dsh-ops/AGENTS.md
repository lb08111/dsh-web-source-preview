# AGENTS.md — dsh-ops

测试环境运维工作台：系统 → 服务 → 服务器 → 任务。Host 半区持有定义账本、
运行器与 `/api/dsh-ops` 路由；浏览器半区渲染树、任务编辑器与运行日志。

## 结构

```
src/
  index.ts        cordis 入口（inject webServer / tools / systemPrompt / sshTransport）
  protocol.ts     Host 与浏览器共享的线协议（纯类型 + 路由常量）
  store.ts        definitions.json 账本（原子写、0600、revision、损坏隔离）
  runs.ts         运行记录与逐目标日志（index.json + runs/<id>.json + logs/）
  runner.ts       目标解析、参数注入、文件上传、bash -s 执行、串行与互斥、取消
  templates.ts    按运行时生成启动/停止/重启/状态/发布任务；发布脚本共享给客户端
  import.ts       CSV 与 ~/.ssh/config 导入（后者经 sshTransport）
  routes.ts       /api/dsh-ops/*（仅 loopback）
  tools.ts        ops_tree / ops_task_get / ops_task_save / ops_task_run / ops_run_status / ops_run_log
  transport.ts    对 dsh-ssh sshTransport 服务的结构化契约（不 import dsh-ssh）
src/client/       API 客户端、locale、面板（树 + 内容 + 对话框 + 运行日志）
```

## 编排（flow）

- 编排是一个任务（`kind: 'flow'`），步骤只引用**脚本任务**（不允许嵌套 flow），
  删除被引用的任务必须被拒绝。
- 父运行 `children` 记录每一步的子运行 id 与状态；子运行就是普通脚本运行，
  日志、取消、错误展示完全复用。
- 相邻的 `mode: 'parallel'` 步骤合成一批并发执行；`failure: 'stop'` 时把剩余
  步骤标为 `skipped`，父运行记 `failed`；`continue` 时跑完全部，混合结果记
  `partial`。
- 父运行没有 targets。运行时选中的服务器是每个步骤的目标上限，与步骤范围及引用任务的默认范围取交集；交集为空时该步骤失败。运行时参数覆盖步骤保存参数。

## 层级写工具

- 系统/服务/服务器分别由 `ops_system_save` / `ops_service_save` / `ops_server_save`
  写；服务器创建统一走 `addServerWithTemplates`（路由与工具共用），别名模式必须
  先在 transport 仓库里存在，newHost 模式才会创建 SSH 主机。
- 删除走 `ops_delete`（`confirm:true`），级联语义与 store 一致；任务被编排引用时
  删除会被拒绝。
- 指南要求模型先 `ops_repo` 查别名、缺信息先问、不要在聊天里索要密码；新增写能力
  时同步更新 `OPS_GUIDANCE` 和 `TOOL_NAMES`，否则工具对模型不可见。

## AI 调用面板

- 宿主工具 `ops_panel` 只写 `PanelBus` 内存队列（容量 32、TTL 5 分钟），
  浏览器 `panel-pump.ts` 每秒 GET `/api/dsh-ops/panel/commands?since=N`；
  应用顺序：`controller.open()` → `select(node)` → `refresh()`。
- 这是纯 UI 指令：不得在 `ops_panel` 里改定义或启动运行；真正的写操作仍走
  `ops_task_save` / `ops_task_run`。
- 浏览器不在线时命令会过期丢弃；不要把它当可靠投递或审计通道。
- `refreshToken` 在 controller 快照里，OpsPanel 监听它重载；不要把 selection
  和它合成一个字段。

## 品牌与配色

- `src/client/brand.tsx` 注册 `sidebar.brand.mark` / `sidebar.brand.name`，并把
  `document.title` 锁成「AI-TEST 管理台」；官方品牌插件由 `cordis.patch.yml` 的
  `ui-brand-official: disabled` 关闭，改品牌不要动运行时包。
- 颜色字段只存在 `OpsSystem` / `OpsService` / `OpsServer`（`color?: string`，
  `#rrggbb`，空值清除）；继承链：服务→系统、服务器→服务、任务→所属服务。
- 卡片强调色走内联 `--accent` CSS 变量，样式用 `color-mix` 混色，不写死主题。

## 定时与通知

- schedule 存在任务定义里（cron + 可选 IANA 时区），校验用 `src/schedule.ts`
  （从 task-board 复制的纯模块，客户端用它做下次运行预览）。
- `TaskScheduler` 每 20 秒扫一遍；到点触发 `runner.start(source: 'cron')`，同一任务
  上一次 cron run 未结束时跳过本次；`markScheduleRun` 只写 `lastRunAt`。
- 错过不补跑；Cron 最小粒度一分钟。
- Webhook 设置存在 definitions 的 `settings`（不是插件 Config）；runner 完成后
  best-effort POST，失败只记日志、不影响运行结果；负载不含命令输出与凭据。
- flow 的子运行 `notify=false`，只有父运行发通知。

## 纪律

- **不 import dsh-ssh**：只通过 `ctx` 注入名为 `sshTransport` 的服务，契约写在
  `src/transport.ts`，结构类型；单测用假 transport。
- **任务默认共享**：一条定义属于服务，默认应用到该服务所有服务器；单台用
  `scope: 'single'` + `serverId`，差异用 `serverOverrides`，不复制脚本。
- **脚本走 stdin**：`bash -s`，参数以环境变量注入；目标选择器不拼 shell。
- **执行串行**：多目标串行；同 SSH 别名用互斥锁串行；流式执行断线不重放。
- **AI 只保存不执行**：`ops_task_save` 只写定义；`ops_task_run` 要求
  `confirm: true`，且必须由用户明确要求。
- **凭据归 dsh-ssh**：新建主机经 `sshTransport.createHost` 写入
  `~/.dsh/dsh-ssh.json`（0600）；本插件不复制、不回显、不写日志。
- **路由只 loopback**：复用 `src/loopback.ts` 围栏；这些接口能在远端执行脚本。
- **账本纪律**：临时文件 + rename、0600、revision 单调递增、损坏文件改名隔离；
  运行态写 `runs/`，不写 `definitions.json`。

## 命令

```sh
pnpm --filter @linxin666/dsh-ops typecheck
pnpm --filter @linxin666/dsh-ops test
pnpm --filter @linxin666/dsh-ops build
```

聚合包注册：`packages/dsh-web-all/aggregate.yml`（patchFrom + deps）→
`node scripts/aggregate.mjs`。
