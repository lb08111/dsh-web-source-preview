# @linxin666/dsh-ops · Test-environment ops workspace

[English](README.md) | 中文

<p align="center">
  <strong>DeepSeek Harness 的测试环境运维工作台</strong><br>
  <em>系统 → 服务 → 服务器 → 任务：卡片式工作台，一套能执行任何事的单元</em>
</p>

没有固定的「发布中心」「脚本库」「任务编排」功能页。工作台用卡片展示系统、服务、服务器和任务，点卡片进入下一层，配置项在编辑弹窗/编辑页里改；任何运维动作（启停、发布、巡检、清理）都是用户在服务器上写的一个任务。

## 层级与卡片

- 首页是系统卡片；点开系统是服务卡片，点开服务是服务器卡片和任务卡片。
- 卡片上直接看统计、服务器、参数/定时/风险；「编辑」打开弹窗或编辑页，不需要配置的东西不出现。
- 顶部搜索跨层级过滤，结果也是卡片。

```
系统（交易系统）
  └─ 服务（订单服务）
       ├─ 服务器（app1-01，SSH 别名 test-app1-01）
       └─ 任务（启动 / 停止 / 重启 / 发布新版本 / 任意脚本）
```

每一级都能 `+` 新建。任务默认建在服务上、自动应用到该服务所有服务器；需要单台时收窄为「仅这台服务器」，差异用服务器参数覆盖表达，不复制脚本。

## 能力

| 能力 | 说明 |
| --- | --- |
| 系统/服务/服务器/任务 | 树形 CRUD；同层级新增；删除节点只删登记，不动服务器上的文件 |
| 服务器仓库 | 复用 dsh-ssh 的主机配置（一个仓库主机可被多个服务引用）；支持分组/标签、CSV 粘贴导入、`~/.ssh/config` 导入；直接新增时在这里填用户名和密码 |
| 任务 = 脚本 + 参数 + 目标 | 脚本通过 `bash -s` 的 stdin 执行；参数以环境变量注入；文件参数先上传到目标机 `/tmp/dsh-ops/<run>/` 再把远端路径传进去 |
| 模板 | 添加服务器时按运行时（systemd / compose / docker / supervisor / custom）生成启动、停止、重启、状态、发布等任务；生成后全部可编辑 |
| 运行 | 目标解析、串行执行、同服务器互斥、超时/取消、逐目标日志、运行记录 |
| 编排 | 编排是一个任务（kind: flow）：按顺序引用其他脚本任务，支持相邻步骤并行、失败策略（停止后续 / 继续执行）、每个步骤生成独立的子运行，可点进去看该步骤的日志。运行时目标选择与步骤保存范围取交集，运行时参数覆盖步骤参数 |
| 定时 | 每个任务可挂一条 5 段 cron（带 IANA 时区）；Host 调度器按分钟触发，同一任务上一次 cron 运行未结束时跳过本次；错过的触发点不补跑 |
| 通知 | 运行结束向 Webhook POST 一条 JSON（事件、状态、目标/步骤摘要；不含命令输出与凭据），可配置「每次结束」或「仅失败」 |
| AI 写脚本 | 走 DSH 自己的对话窗口（不另做聊天）；Agent 用 `ssh_exec` 探测服务器后调用 `ops_task_save` 把脚本保存成任务 |

## Agent 工具

`ops_tree` / `ops_repo` / `ops_system_save` / `ops_service_save` / `ops_server_save` / `ops_delete` / `ops_task_get` / `ops_task_save` / `ops_task_run` / `ops_run_status` / `ops_run_log` / `ops_settings` / `ops_panel`。

`ops_task_save` 只保存不执行；`ops_task_run` 必须由用户明确要求并传 `confirm: true`。

## 安装

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm run deps:install
pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-ssh
dsh plugin --profile web add link:$(pwd)/packages/dsh-ops
```

安装后重启 `dsh web`，侧边栏出现「运维」入口。依赖 `dsh-ssh` 提供的 `sshTransport` 服务。

## 配置

插件条目接受下列配置。修改这些条目值后重新加载 profile。

| 配置项 | 默认值 | 行为 |
| --- | --- | --- |
| `enabled` | `true` | 启用路由、工具与定时运行 |
| `announceToAgent` | `false` | 开启后向 Agent 系统提示词加入工作台指南 |

任务定时和 Webhook 通知在工作台中配置，保存到定义账本。

## 数据

```
$DSH_HOME/ops/
  definitions.json       # 系统/服务/服务器/任务（0600，原子写）
  runs/<runId>.json      # 运行记录
  runs/logs/<runId>/     # 每个目标的日志
```

服务器凭据仍存放在 dsh-ssh 的 `$DSH_HOME/dsh-ssh.json`（0600，默认目录为 `~/.dsh`），本插件不复制、不回显。

## 安全模型

Host 使用配置的 SSH 账号执行远端操作，与 dsh-ssh 共享认证和连接池。HTTP 路由接受直接回环请求及同源浏览器流量。远端部署需要经过认证的访问层，通过回环连接向 Host 转发请求。

脚本可以修改远端服务和文件。Agent 执行工具要求用户发起运行请求后传入 `confirm: true`。流式脚本执行仅尝试一次，SSH 连接丢失记为失败。命令输出原样保存在运行日志中。文件参数是 Host 上的路径，由 Host 进程以其权限读取。

## 已知限制

- 任务的多目标执行为串行；同服务器通过互斥锁避免并发。
- 编排的步骤只能引用脚本任务（不支持嵌套编排）。
- 定时触发的最小粒度是一分钟；Host 停机期间错过的触发点不补跑。
- 文件参数填的是 DSH Host 上的绝对路径（GUI 与 Host 同机时就是本机路径）；还没有浏览器文件选择器。
- 关闭浏览器后 Host 继续执行任务。Host 停机会中断运行器，重启后持久化记录中仍为运行中的任务需要操作人员核对。
- 输出原样返回，可能包含远端敏感信息。

## License

Apache-2.0.
