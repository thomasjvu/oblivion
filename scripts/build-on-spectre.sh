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

ssh "$HOST" bash -s -- "$REMOTE_DIR" "$IMAGE" "$TAG" "$PUSH" <<'REMOTE'
set -euo pipefail
DIR="$1"
IMAGE="$2"
TAG="$3"
PUSH="$4"
cd ~/"$DIR"
docker build -t "$IMAGE:$TAG" -t "$IMAGE:local" .
echo "Built $IMAGE:$TAG on $(hostname)"
if [[ "$PUSH" == "1" ]]; then
  docker push "$IMAGE:$TAG" | tail -1
fi
REMOTE

echo "Remote build complete: $IMAGE:$TAG"
if [[ "$PUSH" == "1" ]]; then
  echo "Pull digest from push output above, then run:"
  echo "  npm run docker:pin -- $IMAGE@sha256:<digest>"
fi