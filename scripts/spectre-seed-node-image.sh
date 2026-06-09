#!/usr/bin/env bash
# Seed spectre with the pinned node base image when Docker Hub pulls fail (public WiFi).
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
INDEX_DIGEST="${OBLIVION_NODE_DIGEST:-sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732}"
AMD64_DIGEST="${OBLIVION_NODE_AMD64_DIGEST:-sha256:32b9e321f262db540d55ac10dc529667cf4737546e097cdd36a843c62bcbf423}"
NODE_IMAGE="node:22-bookworm-slim@${INDEX_DIGEST}"
AMD64_IMAGE="node:22-bookworm-slim@${AMD64_DIGEST}"
GHCR_BASE="${OBLIVION_GHCR_NODE_BASE:-ghcr.io/thomasjvu/oblivion-node-base:22-bookworm-slim-amd64}"
SSH_OPTS=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)
REMOTE_DIR="/tmp/oblivion-node-seed"
CHUNK_MB="${OBLIVION_SEED_CHUNK_MB:-5}"
WORK="$(mktemp -d /tmp/oblivion-node-seed.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

image_present() {
  ssh "${SSH_OPTS[@]}" "$HOST" "docker image inspect '$NODE_IMAGE' >/dev/null 2>&1"
}

if image_present; then
  echo "==> $NODE_IMAGE already present on $HOST"
  ssh "${SSH_OPTS[@]}" "$HOST" "docker images '$NODE_IMAGE' | head -2"
  echo "Spectre node base image ready (cached)"
  exit 0
fi

seed_via_ghcr() {
  echo "==> Try GHCR pull on $HOST ($GHCR_BASE)"
  ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$GHCR_BASE" "$NODE_IMAGE" <<'REMOTE'
set -euo pipefail
GHCR="$1"
NODE="$2"
for attempt in 1 2 3 4 5; do
  echo "ghcr pull attempt $attempt"
  if docker pull "$GHCR"; then
    docker tag "$GHCR" "$NODE"
    docker image inspect "$NODE" >/dev/null
    docker images "$NODE" | head -2
    echo "node base image seeded via GHCR"
    exit 0
  fi
  sleep "$((attempt * 8))"
done
exit 1
REMOTE
}

seed_via_rsync() {
  echo "==> Ensure $AMD64_IMAGE (linux/amd64) exists locally"
  if ! docker image inspect "$AMD64_IMAGE" >/dev/null 2>&1; then
    docker pull "$AMD64_IMAGE"
  fi

  echo "==> Export and split image (~${CHUNK_MB}MB chunks)"
  docker save "$AMD64_IMAGE" | gzip -1 >"$WORK/node.tar.gz"
  split -b "${CHUNK_MB}m" "$WORK/node.tar.gz" "$WORK/node.tar.gz.part-"
  PARTS=( "$WORK"/node.tar.gz.part-* )
  echo "   tarball: $(du -h "$WORK/node.tar.gz" | cut -f1), parts: ${#PARTS[@]}"

  ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $REMOTE_DIR && rm -f $REMOTE_DIR/node.tar.gz.part-*"

  echo "==> Rsync ${#PARTS[@]} chunks to $HOST:$REMOTE_DIR"
  for part in "${PARTS[@]}"; do
    base="$(basename "$part")"
    for attempt in 1 2 3 4 5 6 7 8; do
      if rsync -az --partial --timeout=240 --bwlimit=800 \
        -e "ssh ${SSH_OPTS[*]}" \
        "$part" "$HOST:$REMOTE_DIR/$base"; then
        break
      fi
      if [[ "$attempt" -eq 8 ]]; then
        echo "rsync failed for $base after 8 attempts" >&2
        return 1
      fi
      echo "rsync $base attempt $attempt failed; retrying..." >&2
      sleep 12
    done
  done

  ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$REMOTE_DIR" "$AMD64_IMAGE" "$NODE_IMAGE" <<'REMOTE'
set -euo pipefail
DIR="$1"
AMD64="$2"
INDEX="$3"
cat "$DIR"/node.tar.gz.part-* | gunzip -c | docker load
rm -rf "$DIR"
docker tag "$AMD64" "$INDEX"
docker image inspect "$INDEX" >/dev/null
docker images "$INDEX" | head -2
echo "node base image seeded via rsync"
REMOTE
}

if seed_via_ghcr; then
  echo "Spectre node base image ready (GHCR)"
  exit 0
fi

echo "GHCR pull failed; falling back to chunked rsync from local docker save"
seed_via_rsync
echo "Spectre node base image ready (rsync)"