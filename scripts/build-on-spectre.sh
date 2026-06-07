#!/usr/bin/env bash
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
REMOTE_DIR="${OBLIVION_BUILD_DIR:-builds/oblivion}"
IMAGE="${OBLIVION_IMAGE:-ghcr.io/thomasjvu/oblivion}"
TAG="${OBLIVION_TAG:-$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)}"
PUSH="${OBLIVION_PUSH:-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete \
  --exclude node_modules/ \
  --exclude .git/ \
  --exclude coverage/ \
  --exclude test-results/ \
  --exclude playwright-report/ \
  --exclude .env \
  --exclude '.env.*' \
  -e ssh \
  "$ROOT/" "$HOST:~/$REMOTE_DIR/"

DIGEST=""
BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT

ssh "$HOST" bash -s -- "$REMOTE_DIR" "$IMAGE" "$TAG" "$PUSH" <<'REMOTE' | tee "$BUILD_LOG"
set -euo pipefail
DIR="$1"
IMAGE="$2"
TAG="$3"
PUSH="$4"
cd ~/"$DIR"
docker build -t "$IMAGE:$TAG" -t "$IMAGE:local" .
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