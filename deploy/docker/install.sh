#!/usr/bin/env bash
set -euo pipefail

IMAGE=${DSH_IMAGE:-crpi-n1l0skbmprpjqh57.cn-shenzhen.personal.cr.aliyuncs.com/cj-aiops-platform/dsh-web:latest}
NAME=${DSH_CONTAINER_NAME:-dsh-web}
PORT=${DSH_PORT:-3080}
BIND_ADDRESS=${DSH_BIND_ADDRESS:-0.0.0.0}
INSTALL_DIR=${DSH_INSTALL_DIR:-"$HOME/dsh-web"}
DATA_DIR=${DSH_DATA_DIR:-}
WORKSPACE_DIR=${DSH_WORKSPACE_DIR:-}
PUBLIC_URL=${DSH_PUBLIC_URL:-}
REGISTRY_USER=${DSH_REGISTRY_USER:-}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)
CREDENTIALS_FILE=${DSH_REGISTRY_CREDENTIALS:-"$SCRIPT_DIR/registry.credentials"}
SKIP_LOGIN=false
INSTALL_DOCKER=true
DOCKER=(docker)
USE_SUDO=false

usage() {
  cat <<'HELP'
Usage: bash install.sh [options]
  --image IMAGE            Image to pull and deploy
  --name NAME              Container name (default dsh-web)
  --port PORT              Published port (default 3080)
  --bind-address ADDRESS   Published address (default 0.0.0.0)
  --install-dir PATH       Deployment directory (default $HOME/dsh-web)
  --data-dir PATH          Persistent DSH_HOME directory
  --workspace-dir PATH     Persistent workspace directory
  --public-url URL         Browser origin, for example http://192.168.1.20:3080
  --registry-user USER     Alibaba Cloud registry username
  --credentials-file PATH  Literal REGISTRY/USERNAME/PASSWORD file
  --skip-login             Use existing Docker credentials only
  --no-install-docker      Require an existing Docker installation
  --help                   Show this help

The registry password is read privately from the terminal when needed.
For unattended use set DSH_REGISTRY_USER and DSH_REGISTRY_PASSWORD.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image|--name|--port|--bind-address|--install-dir|--data-dir|--workspace-dir|--public-url|--registry-user|--credentials-file)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      option=$1
      value=$2
      case "$option" in
        --image) IMAGE=$value ;; --name) NAME=$value ;; --port) PORT=$value ;;
        --bind-address) BIND_ADDRESS=$value ;; --install-dir) INSTALL_DIR=$value ;;
        --data-dir) DATA_DIR=$value ;; --workspace-dir) WORKSPACE_DIR=$value ;;
        --public-url) PUBLIC_URL=$value ;; --registry-user) REGISTRY_USER=$value ;;
        --credentials-file) CREDENTIALS_FILE=$value ;;
      esac
      shift 2 ;;
    --skip-login) SKIP_LOGIN=true; shift ;;
    --no-install-docker) INSTALL_DOCKER=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'This installer requires Linux amd64.' >&2; exit 1; }
[[ $PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || { echo 'Invalid published port.' >&2; exit 2; }
[[ $NAME =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo 'Invalid container name.' >&2; exit 2; }
if [[ $(id -u) -ne 0 ]] && command -v sudo >/dev/null 2>&1; then USE_SUDO=true; fi

privileged() {
  if [[ $USE_SUDO == true ]]; then sudo "$@"; else "$@"; fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    echo 'Install curl or wget, then run this installer again.' >&2
    return 1
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  [[ $INSTALL_DOCKER == true ]] || { echo 'Docker is required.' >&2; exit 1; }
  docker_installer=$(mktemp)
  trap 'rm -f "$docker_installer"' EXIT
  download https://get.docker.com "$docker_installer"
  privileged sh "$docker_installer"
  rm -f "$docker_installer"
  trap - EXIT
fi

if ! docker info >/dev/null 2>&1; then
  if [[ $USE_SUDO == true ]] && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    if command -v systemctl >/dev/null 2>&1; then privileged systemctl start docker; fi
    if ! docker info >/dev/null 2>&1 && [[ $USE_SUDO == true ]]; then DOCKER=(sudo docker); fi
    "${DOCKER[@]}" info >/dev/null
  fi
fi

mkdir -p "$INSTALL_DIR"
INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P)
if ! command -v flock >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    privileged apt-get update
    privileged apt-get install -y util-linux
  elif command -v dnf >/dev/null 2>&1; then
    privileged dnf install -y util-linux
  elif command -v yum >/dev/null 2>&1; then
    privileged yum install -y util-linux
  fi
fi
command -v flock >/dev/null 2>&1 || { echo 'The util-linux flock command is required.' >&2; exit 1; }
exec 9>"$INSTALL_DIR/.deploy.lock"
flock 9

REGISTRY=${IMAGE%%/*}
if ! "${DOCKER[@]}" pull --platform linux/amd64 "$IMAGE"; then
  [[ $SKIP_LOGIN == false ]] || { echo 'Image pull failed. Check the image and existing Docker login.' >&2; exit 1; }
  file_registry=
  file_username=
  file_password=
  if [[ -f $CREDENTIALS_FILE ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      line=${line%$'\r'}
      case "$line" in
        REGISTRY=*) file_registry=${line#*=} ;;
        USERNAME=*) file_username=${line#*=} ;;
        PASSWORD=*) file_password=${line#*=} ;;
      esac
    done <"$CREDENTIALS_FILE"
    [[ $file_registry == "$REGISTRY" ]] || { echo 'The credentials file names a different registry.' >&2; exit 1; }
  fi
  REGISTRY_USER=${REGISTRY_USER:-$file_username}
  if [[ -z $REGISTRY_USER ]]; then
    read -r -p 'Alibaba Cloud registry username: ' REGISTRY_USER </dev/tty
  fi
  password=${DSH_REGISTRY_PASSWORD:-$file_password}
  unset file_password
  unset DSH_REGISTRY_PASSWORD
  if [[ -z $password ]]; then
    read -r -s -p 'Alibaba Cloud registry password: ' password </dev/tty
    printf '\n' >/dev/tty
  fi
  printf '%s' "$password" | "${DOCKER[@]}" login "$REGISTRY" --username "$REGISTRY_USER" --password-stdin
  unset password
  "${DOCKER[@]}" pull --platform linux/amd64 "$IMAGE"
fi

RUN_USER="$(id -u):$(id -g)"
existing=$("${DOCKER[@]}" container inspect --format '{{index .Config.Labels "com.leomind.dsh-web"}}' "$NAME" 2>/dev/null || true)
BACKUP=
if [[ -n $existing ]]; then
  [[ $existing == managed ]] || { echo "Container $NAME belongs to another deployment." >&2; exit 1; }
  RUN_USER=$("${DOCKER[@]}" container inspect --format '{{.Config.User}}' "$NAME")
  RUN_USER=${RUN_USER:-0:0}
  if [[ -z $DATA_DIR ]]; then
    DATA_DIR=$("${DOCKER[@]}" container inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "bind")}}{{.Source}}{{end}}{{end}}' "$NAME")
    [[ -n $DATA_DIR ]] || { echo 'The managed container has no /data bind mount; specify --data-dir.' >&2; exit 1; }
  fi
  if [[ -z $WORKSPACE_DIR ]]; then
    WORKSPACE_DIR=$("${DOCKER[@]}" container inspect --format '{{range .Mounts}}{{if and (eq .Destination "/workspace") (eq .Type "bind")}}{{.Source}}{{end}}{{end}}' "$NAME")
    [[ -n $WORKSPACE_DIR ]] || { echo 'The managed container has no /workspace bind mount; specify --workspace-dir.' >&2; exit 1; }
  fi
  BACKUP="$NAME-previous-$(date +%s)"
elif "${DOCKER[@]}" container inspect "$NAME" >/dev/null 2>&1; then
  echo "Container $NAME belongs to another deployment." >&2
  exit 1
fi

DATA_DIR=${DATA_DIR:-"$INSTALL_DIR/data"}
WORKSPACE_DIR=${WORKSPACE_DIR:-"$INSTALL_DIR/workspace"}
mkdir -p "$DATA_DIR" "$WORKSPACE_DIR"
DATA_DIR=$(cd "$DATA_DIR" && pwd -P)
WORKSPACE_DIR=$(cd "$WORKSPACE_DIR" && pwd -P)
if [[ -z $PUBLIC_URL ]]; then
  address=$BIND_ADDRESS
  if [[ $address == 0.0.0.0 ]]; then
    address=$(hostname -I 2>/dev/null | awk '{print $1}')
    address=${address:-127.0.0.1}
  fi
  [[ $address != *:* ]] || address="[$address]"
  PUBLIC_URL="http://$address:$PORT"
fi
PUBLIC_URL=$("${DOCKER[@]}" run --rm --network none --entrypoint node "$IMAGE" -e '
  try {
    const url = new URL(process.argv[1]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    process.stdout.write(url.origin);
  } catch {
    console.error("PUBLIC_URL must be one HTTP(S) origin without credentials, a path, query, or fragment");
    process.exit(1);
  }
' "$PUBLIC_URL")

NEW_ATTEMPTED=false
PREVIOUS_RENAMED=false
rollback() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    if [[ $NEW_ATTEMPTED == true ]]; then
      "${DOCKER[@]}" logs --tail 60 "$NAME" >&2 2>/dev/null || true
      "${DOCKER[@]}" rm --force "$NAME" >/dev/null 2>&1 || true
    fi
    if [[ $PREVIOUS_RENAMED == true ]]; then
      "${DOCKER[@]}" rename "$BACKUP" "$NAME"
      "${DOCKER[@]}" start "$NAME" >/dev/null
      echo 'The previous container was restarted with the persistent directories.' >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT

if [[ -n $BACKUP ]]; then
  "${DOCKER[@]}" rename "$NAME" "$BACKUP"
  PREVIOUS_RENAMED=true
  "${DOCKER[@]}" stop --time 30 "$BACKUP" >/dev/null
fi
NEW_ATTEMPTED=true
"${DOCKER[@]}" run --detach --init --platform linux/amd64 \
  --name "$NAME" --label com.leomind.dsh-web=managed \
  --restart unless-stopped --stop-timeout 30 \
  --user "$RUN_USER" \
  --publish "$BIND_ADDRESS:$PORT:8080" \
  --env "PUBLIC_URL=$PUBLIC_URL" \
  --env TZ=Asia/Shanghai \
  --volume "$DATA_DIR:/data" \
  --volume "$WORKSPACE_DIR:/workspace" \
  "$IMAGE" >/dev/null

entry=
ready=false
for attempt in $(seq 1 120); do
  state=$("${DOCKER[@]}" inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME")
  if [[ $state == *unhealthy* || $state == exited* || $state == dead* ]]; then
    echo "Container did not start successfully: $state" >&2
    exit 1
  fi
  if [[ $state == 'running healthy' ]]; then
    entry=$("${DOCKER[@]}" exec "$NAME" cat /data/.browser-entry 2>/dev/null || true)
    if [[ $entry == "$PUBLIC_URL"*token=* ]]; then ready=true; break; fi
  fi
  sleep 2
done
[[ $ready == true ]] || { echo 'Timed out waiting for the authenticated browser URL.' >&2; exit 1; }
if [[ -n $BACKUP ]]; then "${DOCKER[@]}" rm "$BACKUP" >/dev/null; fi
trap - EXIT
printf '\nDeployment ready\nBrowser URL: %s\nData: %s\nWorkspace: %s\nContainer: %s\n' "$entry" "$DATA_DIR" "$WORKSPACE_DIR" "$NAME"
