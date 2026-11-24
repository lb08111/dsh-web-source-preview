# @linxin666/dsh-ops · Test-environment ops workspace

English | [中文](README.zh.md)

<p align="center">
  <strong>A test-environment operations workspace for DeepSeek Harness</strong><br>
  <em>System → service → server → task: a card workspace, and one unit that can do anything</em>
</p>

There are no fixed “release center”, “script library” or “orchestration” pages. The workspace shows systems, services, servers and tasks as cards; click a card to drill down and edit through a dialog or the editor page. Every operational action (start, stop, deploy, inspect, clean) is a task the user writes on a server.

## Hierarchy and cards

- The landing page is a grid of system cards; a system opens its service cards, and a service opens its server and task cards.
- Cards carry their stats, server chips, schedule/risk/targets; “Edit” opens a dialog or the editor page, and unneeded configuration stays hidden.
- The header search filters across every level and returns cards too.

```
System (trade)
  └─ Service (order)
       ├─ Server (app1-01, SSH alias test-app1-01)
       └─ Task (start / stop / restart / publish / any script)
```

Every level has a `+`. A task is defined on the service and applies to all of its servers by default; narrow it to one server when needed, and express per-server differences with parameter overrides instead of copying scripts.

## Capabilities

| Capability | Behavior |
| --- | --- |
| System / service / server / task | Tree CRUD with inline creation; deleting a node removes the registration only, never files on the server |
| Server repository | Reuses dsh-ssh host entries (one repository host may be referenced by several services); groups/tags, CSV paste import, `~/.ssh/config` import; inline creation asks for username and password |
| Task = script + parameters + target | The script runs through `bash -s` on stdin; parameters are injected as environment variables; a file parameter is uploaded to `/tmp/dsh-ops/<run>/` on the target and its remote path is injected |
| Templates | Adding a server generates start/stop/restart/status/publish tasks for its runtime (systemd / compose / docker / supervisor / custom); every generated task stays editable |
| Runs | Target resolution, serial execution, per-server mutex, timeout/cancel, per-target logs and run history |
| Orchestration | A flow is a task (`kind: flow`): an ordered chain of script tasks, adjacent steps can run in parallel, failure policy (stop remaining / continue), and every step gets its own child run with its own log. Runtime target selection intersects each step's saved scope, and runtime parameters override step values |
| Schedule | Each task can carry one 5-field cron expression with an IANA time zone; the Host scheduler fires at minute boundaries, skips an occurrence while the previous cron run of the same task is active, and does not replay missed occurrences |
| Notifications | A finished run POSTs one JSON document to a webhook (event, status, target/step summary; no command output, no credentials), configured for every finish or failures only |
| AI authoring | Uses the native DSH conversation (no custom chat): the agent inspects the server with `ssh_exec`, then saves the script as a task through `ops_task_save` |

## Agent tools

`ops_tree` / `ops_repo` / `ops_system_save` / `ops_service_save` / `ops_server_save` / `ops_delete` / `ops_task_get` / `ops_task_save` / `ops_task_run` / `ops_run_status` / `ops_run_log` / `ops_settings` / `ops_panel`.

`ops_task_save` only persists; `ops_task_run` requires an explicit user request and `confirm: true`.

## Install

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm run deps:install
pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-ssh
dsh plugin --profile web add link:$(pwd)/packages/dsh-ops
```

Restart `dsh web` after installing; a sidebar “Ops” entry appears. The plugin depends on the `sshTransport` service provided by dsh-ssh.

## Config

The plugin entry accepts the following configuration. Reload the profile after changing these entry values.

| Setting | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Enables routes, tools and scheduled runs |
| `announceToAgent` | `false` | Adds the workspace guidance to agent system prompts when enabled |

Task schedules and webhook notifications are configured in the workspace and saved in its definitions ledger.

## Data

```
$DSH_HOME/ops/
  definitions.json       # systems/services/servers/tasks (0600, atomic writes)
  runs/<runId>.json      # run records
  runs/logs/<runId>/     # per-target logs
```

Server credentials stay in dsh-ssh's `$DSH_HOME/dsh-ssh.json` (0600, `~/.dsh` by default); this plugin neither copies nor echoes them.

## Security model

The Host performs remote operations with the configured SSH account and shares dsh-ssh's authentication and connection pool. Its HTTP routes accept direct loopback requests and same-origin browser traffic. A remote deployment needs an authenticated access layer that forwards requests to the Host through loopback.

Scripts can change remote services and files. The agent execution tool requires `confirm: true` after the user requests a run. Streamed script execution makes one attempt, and a lost SSH connection records a failure. Command output is stored verbatim in the run logs. File parameters are paths on the Host and are read with the Host process's permissions.

## Known limitations

- Multi-target runs are serial; a per-server mutex prevents overlap.
- Flow steps may only reference script tasks (no nested flows).
- Scheduled runs have one-minute granularity; occurrences missed while the Host is down are not replayed.
- A file parameter takes an absolute path on the DSH Host (the local path when the GUI and Host share a machine); there is no browser file picker yet.
- Closing the browser leaves Host runs active. Host shutdown interrupts the runner, and persisted running records need operator verification after restart.
- Output is returned verbatim and may contain remote secrets.

## License

Apache-2.0.
