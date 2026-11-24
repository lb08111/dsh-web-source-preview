/**
 * Starter tasks generated when a server is attached to a service.
 *
 * Templates are only a starting point: every generated task is a normal,
 * fully editable task definition owned by the service and applied to all of
 * its servers. They read the per-server runtime from built-in environment
 * variables the runner injects, so one definition works on every server.
 */

import type { RuntimeSpec, TaskInput } from './protocol.ts'

/** Built-in env vars injected by the runner for every target. */
export const BUILTIN_ENV = {
  runId: 'DSH_RUN_ID',
  serverId: 'DSH_SERVER_ID',
  alias: 'DSH_SERVER_ALIAS',
  name: 'DSH_SERVER_NAME',
  runtime: 'DSH_SERVER_RUNTIME',
  unit: 'DSH_SERVER_UNIT',
  workdir: 'DSH_SERVER_WORKDIR',
  port: 'DSH_SERVER_PORT',
  composeFile: 'DSH_SERVER_COMPOSE',
} as const

/** Shell quoting for the generated `unit` values (single-quote safe). */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** systemd unit expression, falling back to the built-in variable. */
function unitExpr(runtime: RuntimeSpec): string {
  return runtime.unit !== undefined && runtime.unit !== ''
    ? quote(runtime.unit)
    : `"${BUILTIN_ENV.unit}"`
}

/** One template task. */
function task(name: string, script: string, options: Partial<TaskInput> = {}): TaskInput {
  return {
    owner: { kind: 'service', id: '' },
    name,
    script,
    params: [],
    env: {},
    timeoutMs: 120_000,
    risk: 'write',
    scope: 'all',
    ...options,
  }
}

/**
 * Build the starter task definitions for one runtime.
 * @param serviceId - owning service.
 * @param runtime - the runtime the server declared.
 * @returns task payloads (empty for a custom runtime).
 */
export function starterTasks(serviceId: string, runtime: RuntimeSpec): TaskInput[] {
  const owner = { kind: 'service' as const, id: serviceId }
  const unit = unitExpr(runtime)
  const tasks: TaskInput[] = []

  if (runtime.kind === 'systemd' || runtime.kind === 'supervisor') {
    const tool = runtime.kind === 'systemd' ? 'systemctl' : 'supervisorctl'
    tasks.push(
      task('启动服务', `#!/bin/bash\nset -euo pipefail\n${tool} start ${unit}\n${tool} is-active ${unit} || true\n`, {
        owner,
        description: `通过 ${tool} 启动服务`,
        risk: 'write',
      }),
      task('停止服务', `#!/bin/bash\nset -euo pipefail\n${tool} stop ${unit}\n`, {
        owner,
        description: `通过 ${tool} 停止服务`,
        risk: 'write',
      }),
      task('重启服务', `#!/bin/bash\nset -euo pipefail\n${tool} restart ${unit}\n${tool} is-active ${unit} || true\n`, {
        owner,
        description: `通过 ${tool} 重启服务`,
        risk: 'write',
      }),
      task('查看状态', `#!/bin/bash\nset -euo pipefail\n${tool} status ${unit} || true\n`, {
        owner,
        description: `查看 ${tool} 状态`,
        risk: 'read',
      }),
    )
  } else if (runtime.kind === 'compose') {
    const compose = runtime.composeFile !== undefined && runtime.composeFile !== ''
      ? quote(runtime.composeFile)
      : '"${DSH_SERVER_COMPOSE:?compose file missing}"'
    const prefix = `docker compose -f ${compose}`
    tasks.push(
      task('启动容器', `#!/bin/bash\nset -euo pipefail\n${prefix} up -d\n`, {
        owner,
        description: 'docker compose up -d',
        risk: 'write',
      }),
      task('停止容器', `#!/bin/bash\nset -euo pipefail\n${prefix} stop\n`, {
        owner,
        description: 'docker compose stop',
        risk: 'write',
      }),
      task('重启容器', `#!/bin/bash\nset -euo pipefail\n${prefix} restart\n`, {
        owner,
        description: 'docker compose restart',
        risk: 'write',
      }),
      task('查看状态', `#!/bin/bash\nset -euo pipefail\n${prefix} ps || true\n`, {
        owner,
        description: 'docker compose ps',
        risk: 'read',
      }),
      task('更新镜像', `#!/bin/bash\nset -euo pipefail\n${prefix} pull\n${prefix} up -d --force-recreate\n`, {
        owner,
        description: '拉取新镜像并重建容器',
        risk: 'write',
        timeoutMs: 300_000,
      }),
    )
  } else if (runtime.kind === 'docker') {
    const container = runtime.unit !== undefined && runtime.unit !== ''
      ? quote(runtime.unit)
      : '"${DSH_SERVER_UNIT:?container name missing}"'
    tasks.push(
      task('启动容器', `#!/bin/bash\nset -euo pipefail\ndocker start ${container}\n`, { owner, description: 'docker start' }),
      task('停止容器', `#!/bin/bash\nset -euo pipefail\ndocker stop ${container}\n`, { owner, description: 'docker stop' }),
      task('重启容器', `#!/bin/bash\nset -euo pipefail\ndocker restart ${container}\n`, { owner, description: 'docker restart' }),
      task('查看状态', `#!/bin/bash\nset -euo pipefail\ndocker inspect -f '{{.State.Status}}' ${container} || true\n`, {
        owner,
        description: 'docker inspect',
        risk: 'read',
      }),
    )
  }

  // File-based release template: version directory + `current` symlink + a
  // bounded health check that rolls back to the previous release.
  if (runtime.kind === 'systemd' || runtime.kind === 'custom') {
    tasks.push(task('发布新版本', publishScript(), {
      owner,
      description: '版本目录 + current 软链 + 健康检查 + 失败回滚',
      risk: 'write',
      timeoutMs: 300_000,
      params: [
        { name: 'VERSION', label: '版本号', type: 'text', required: true, description: '例如 1.2.4' },
        { name: 'ARTIFACT', label: '产物文件', type: 'file', required: false, description: '本机文件路径；运行时会自动传到目标机' },
        { name: 'PORT', label: '健康检查端口', type: 'number', required: false, description: '留空则用服务器端口' },
      ],
    }))
  }

  return tasks
}

/** The file-based release script shared by systemd and custom runtimes. */
export function publishScript(): string {
  return `#!/bin/bash
set -euo pipefail

VERSION="\${VERSION:?VERSION is required}"
ROOT="\${DSH_SERVER_WORKDIR:-/opt/app}"
UNIT="\${DSH_SERVER_UNIT:-}"
PORT="\${PORT:-\${DSH_SERVER_PORT:-8080}}"
ARTIFACT="\${ARTIFACT:-}"
TARGET="$ROOT/releases/$VERSION"

echo "[1/5] 准备 $TARGET"
mkdir -p "$TARGET"
if [ -n "$ARTIFACT" ]; then
  cp "$ARTIFACT" "$TARGET/app.jar"
fi

echo "[2/5] 停止服务"
if [ -n "$UNIT" ]; then
  systemctl stop "$UNIT" || true
fi

echo "[3/5] 切换 current"
PREV="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
ln -sfn "$TARGET" "$ROOT/current"

echo "[4/5] 启动服务"
if [ -n "$UNIT" ]; then
  systemctl start "$UNIT"
fi

echo "[5/5] 健康检查 http://127.0.0.1:$PORT"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/actuator/health" >/dev/null 2>&1 \\
    || curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "健康检查通过"
    exit 0
  fi
  sleep 2
done

echo "健康检查失败，回滚到 \${PREV:-无}"
if [ -n "\${PREV:-}" ]; then
  ln -sfn "$PREV" "$ROOT/current"
  if [ -n "$UNIT" ]; then
    systemctl restart "$UNIT"
  fi
fi
exit 1
`
}
