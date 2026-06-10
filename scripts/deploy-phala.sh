#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="${OBLIVION_PHALA_COMPOSE:-$ROOT/docker-compose.phala.yml}"
NAME="${OBLIVION_PHALA_NAME:-oblivion}"
HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
PHALA="${PHALA_CMD:-phala}"
ENV_FILE="${OBLIVION_ENV_FILE:-$ROOT/.env}"
PHALA_TAG="${OBLIVION_PHALA_TAG:-}"
PUBLIC_API_URL="${OBLIVION_PUBLIC_API_URL:-https://3a522af6627d93bb480ba7bd39d375a1535aefa8-8080.dstack-pha-prod5.phala.network}"
CORS_ORIGIN="${OBLIVION_CORS_ORIGIN:-https://oblivion.phantasy.bot}"
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

if [[ -n "$PHALA_TAG" ]]; then
  perl -0pi -e "s|image: ghcr.io/thomasjvu/oblivion:[^\n]+|image: ghcr.io/thomasjvu/oblivion:$PHALA_TAG|" "$COMPOSE"
fi
perl -0pi -e "s|OBLIVION_PUBLIC_API_URL=[^\n]+|OBLIVION_PUBLIC_API_URL=$PUBLIC_API_URL|" "$COMPOSE"
perl -0pi -e "s|OBLIVION_CORS_ORIGIN=[^\n]+|OBLIVION_CORS_ORIGIN=$CORS_ORIGIN|" "$COMPOSE"

ENV_ARGS=(
  -e "DSTACK_DOCKER_REGISTRY=ghcr.io"
  -e "DSTACK_DOCKER_USERNAME=$DSTACK_DOCKER_USERNAME"
  -e "DSTACK_DOCKER_PASSWORD=$DSTACK_DOCKER_PASSWORD"
  -e "OBLIVION_PUBLIC_API_URL=$PUBLIC_API_URL"
  -e "OBLIVION_CORS_ORIGIN=$CORS_ORIGIN"
  -e "OBLIVION_PREVIEW_DAILY_LIMIT=${OBLIVION_PREVIEW_DAILY_LIMIT:-0}"
)
if [[ -f "$ENV_FILE" ]]; then
  ENV_ARGS+=(-e "$ENV_FILE")
fi

echo "Deploying $NAME to Phala Cloud..."
"$PHALA" deploy \
  "${DEPLOY_ARGS[@]}" \
  -c "$COMPOSE" \
  --instance-type "${OBLIVION_PHALA_INSTANCE_TYPE:-tdx.small}" \
  --listed \
  --wait \
  "${ENV_ARGS[@]}" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo "Deployed $NAME. Fetch details with: phala cvms get $NAME"