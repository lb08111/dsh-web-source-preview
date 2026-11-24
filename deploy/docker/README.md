# DSH Web container deployment

English | [中文](README.zh.md)

This deployment packages the source-built DSH Web family, including the operations workspace, with the official DeepSeek Harness runtime. The image targets Linux amd64, uses Node 24.22.3 and DSH 0.2.2-rc.3, and stores application data outside the image.

## What it does

- Builds every workspace plugin from source and creates an independent production dependency tree with one official host SDK.
- Serves the Web UI, SSH host repository and operations workspace through an authenticated same-origin container entry.
- Persists sessions, provider settings, SSH configuration and operation records under `/data`, and project files under `/workspace`.
- Updates an existing managed container while retaining both persistent directories, and restarts the previous container when the replacement fails its startup checks.

## Install

Place `install.sh` on a Linux amd64 server. A private delivery may also contain `registry.credentials` beside it, with the literal keys `REGISTRY`, `USERNAME` and `PASSWORD`. The installer reads these values as data and supplies the password through Docker standard input.

```sh
bash install.sh --public-url http://192.168.1.20:3080
```

The installer uses an existing Docker engine or installs Docker through its official installation script. It pulls `crpi-n1l0skbmprpjqh57.cn-shenzhen.personal.cr.aliyuncs.com/cj-aiops-platform/dsh-web:latest`, starts the container, and prints the current browser URL containing the login token. Use that complete URL for the first visit.

Run the same command to update. A first installation defaults to `$HOME/dsh-web`, with separate `data` and `workspace` directories, and uses the invoking user's numeric UID and GID. Updates reuse the managed container's existing bind directories and configured user, including when rerun through sudo or a different home directory. Explicit `--data-dir`, `--workspace-dir`, `DSH_DATA_DIR` or `DSH_WORKSPACE_DIR` values override the corresponding directory.

## Config

`bash install.sh --help` lists the supported options. Set `--image` to deploy an immutable version tag, `--data-dir` and `--workspace-dir` to retain existing directories, and `--port` to change the published port. `--public-url` is the exact origin used by the browser, including an explicit non-default port. A reverse proxy can terminate HTTPS and forward to the published port while preserving that public Host and Origin.

Registry credentials can also be provided through `DSH_REGISTRY_USER` and `DSH_REGISTRY_PASSWORD`. When no saved Docker login or matching credentials file is available, the installer prompts privately. `--credentials-file` selects a different literal credentials file; `--skip-login` requires existing Docker credentials.

After login, configure the model provider and SSH hosts in the application. Model requests use the configured provider. Set an internal model endpoint when the model service runs on your network. The initial profile enables SSH and the operations workspace; later profile settings are retained during container replacement.

```sh
docker logs --tail 100 dsh-web
docker exec dsh-web cat /data/.browser-entry
docker stop --time 30 dsh-web
docker start dsh-web
```

## Build

Build from the repository root with a clean source context. Runtime credentials belong in the persistent data directory or the private delivery, and the Docker ignore rules exclude credential files and local dependency trees.

```sh
docker buildx build --platform linux/amd64 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag crpi-n1l0skbmprpjqh57.cn-shenzhen.personal.cr.aliyuncs.com/cj-aiops-platform/dsh-web:latest \
  --load .
```

The Docker build compiles the workspace on BuildKit's native build platform with the same official SDK version. It removes existing package libraries before compilation and transfers only verified portable `packages/*/lib` outputs, including declarations, copied browser assets and shell metadata. A separate target-platform stage installs production dependencies from the lockfile, creates the production closure, and pins shared SDK imports to its official runtime installation. Build-platform dependency trees never enter the runtime image. The image contains the published satellite dependencies declared by the aggregate package, including their target-platform native dependencies.

## Security model

The public entry accepts the configured Host and matching browser Origin. It exchanges the native DSH launch token for the official signed browser-owner cookie. Every subsequent HTTP request and WebSocket upgrade verifies that browser-owner cookie through DSH before the proxy forwards to the loopback-only backend. The proxy then translates the validated request to the internal authority. The SSH and operations plugin fences remain active.

The backend listens only on container loopback port 3080; Docker publishes the proxy on port 8080 inside the container. The container health check verifies the Web entry, an empty plugin degradation ledger, the operations tree and the SSH host repository before the installer reports success. The default launch environment disables official session telemetry and session-log uploads. The community plugin suite has its own browser-side telemetry preference under Settings, Web plugins, Anonymous installation telemetry.

## Known limitations

- The initial model provider and SSH credentials are configured after deployment; they are stored in `/data`.
- Native browser automation and external integrations require their own dependencies and service configuration.
- Public access uses one configured browser origin. Change `--public-url` when moving the service to a different address.
- Container rollback retains the same persistent directories. Application data and separately maintained backups remain the operator's responsibility.
