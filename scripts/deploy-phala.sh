#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="${OBLIVION_PHALA_COMPOSE:-$ROOT/docker-compose.phala.yml}"
NAME="${OBLIVION_PHALA_NAME:-oblivion}"
HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
PHALA="${PHALA_CMD:-phala}"
EXTRA_ARGS=()
if (($# > 0)); then
  EXTRA_ARGS=("$@")
fi

if [[ ! -f "$COMPOSE" ]]; then
  echo "Compose file not found: $COMPOSE" >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  DSTACK_DOCKER_USERNAME=thomasjvu
  DSTACK_DOCKER_PASSWORD="$(gh auth token)"
else
  read -r DSTACK_DOCKER_USERNAME DSTACK_DOCKER_PASSWORD < <(
    ssh "$HOST" 'python3 - <<'"'"'PY'"'"'
import base64, json, pathlib
cfg = json.loads(pathlib.Path.home().joinpath(".docker/config.json").read_text())
auth = cfg.get("auths", {}).get("ghcr.io", {}).get("auth")
if not auth:
    raise SystemExit("ghcr.io credentials missing on build host")
user, password = base64.b64decode(auth).decode().split(":", 1)
print(user)
print(password)
PY'
  )
fi

DEPLOY_ARGS=(-n "$NAME")
if "$PHALA" cvms get "$NAME" >/dev/null 2>&1; then
  DEPLOY_ARGS=(--cvm-id "$NAME")
fi

echo "Deploying $NAME to Phala Cloud..."
"$PHALA" deploy \
  "${DEPLOY_ARGS[@]}" \
  -c "$COMPOSE" \
  --instance-type "${OBLIVION_PHALA_INSTANCE_TYPE:-tdx.small}" \
  --listed \
  --wait \
  -e "DSTACK_DOCKER_REGISTRY=ghcr.io" \
  -e "DSTACK_DOCKER_USERNAME=$DSTACK_DOCKER_USERNAME" \
  -e "DSTACK_DOCKER_PASSWORD=$DSTACK_DOCKER_PASSWORD" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo "Deployed $NAME. Fetch details with: phala cvms get $NAME"