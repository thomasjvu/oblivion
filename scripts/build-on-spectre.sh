#!/usr/bin/env bash
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
REMOTE_DIR="${OBLIVION_BUILD_DIR:-builds/oblivion}"
REPO_URL="${OBLIVION_REPO_URL:-git@github.com:thomasjvu/oblivion.git}"
IMAGE="${OBLIVION_IMAGE:-ghcr.io/thomasjvu/oblivion}"
TAG="${OBLIVION_TAG:-$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)}"
PUSH="${OBLIVION_PUSH:-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_REF="${OBLIVION_GIT_REF:-$(git -C "$ROOT" rev-parse HEAD)}"
SSH_OPTS=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)

echo "==> Apply spectre Docker/network fix before sync"
OBLIVION_SKIP_DOCKER_PULL=1 bash "$ROOT/scripts/spectre-dns-fix.sh"

echo "==> Ensure node base image is present on $HOST"
bash "$ROOT/scripts/spectre-seed-node-image.sh"

echo "==> Git sync on $HOST (~/$REMOTE_DIR @ ${GIT_REF:0:7})"
for attempt in 1 2 3; do
  if ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$REMOTE_DIR" "$REPO_URL" "$GIT_REF" <<'REMOTE'; then
set -euo pipefail
DIR="$1"
REPO="$2"
REF="$3"
TARGET=~/"$DIR"
if [[ -d "$TARGET/.git" ]]; then
  cd "$TARGET"
  git remote set-url origin "$REPO"
  git fetch origin --prune
else
  rm -rf "$TARGET"
  git clone "$REPO" "$TARGET"
  cd "$TARGET"
  git fetch origin --prune
fi
git reset --hard "$REF"
git clean -fd
echo "Checked out $(git rev-parse --short HEAD) in $TARGET"
REMOTE
    break
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "git sync failed after 3 attempts" >&2
    exit 1
  fi
  echo "git sync attempt $attempt failed; retrying in 10s..." >&2
  sleep 10
done

DIGEST=""
BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT

ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$REMOTE_DIR" "$IMAGE" "$TAG" "$PUSH" <<'REMOTE' | tee "$BUILD_LOG"
set -euo pipefail
DIR="$1"
IMAGE="$2"
TAG="$3"
PUSH="$4"
cd ~/"$DIR"
docker build --network=host -t "$IMAGE:$TAG" -t "$IMAGE:local" .
echo "Built $IMAGE:$TAG on $(hostname)"
if [[ "$PUSH" == "1" ]]; then
  docker push "$IMAGE:$TAG"
fi
REMOTE

echo "Remote build complete: $IMAGE:$TAG"
if [[ "$PUSH" == "1" ]]; then
  DIGEST="$(grep -Eo 'digest: sha256:[0-9a-f]{64}' "$BUILD_LOG" | tail -1 | cut -d' ' -f2)"
  if [[ -z "$DIGEST" ]]; then
    echo "Could not resolve image digest from remote push output." >&2
    exit 1
  fi
  echo "OBLIVION_IMAGE_DIGEST=$DIGEST"
fi