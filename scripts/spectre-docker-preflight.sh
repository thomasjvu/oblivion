#!/usr/bin/env bash
# Quick connectivity check before build-on-spectre / deploy:production.
set -euo pipefail

HOST="${OBLIVION_BUILD_HOST:-spectre.thomasjvu.com}"
NODE_DIGEST="${OBLIVION_NODE_DIGEST:-sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732}"

echo "==> SSH to $HOST"
ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 "$HOST" bash -s <<REMOTE
set -euo pipefail
NODE_IMAGE="node:22-bookworm-slim@${NODE_DIGEST}"
echo "host: \$(hostname)"
echo "wifi: \$(nmcli -t -f DEVICE,STATE,CONNECTION dev | grep wifi || true)"
echo "resolv:"; cat /etc/resolv.conf
echo "hosts:"; grep oblivion-docker-hub -A6 /etc/hosts || echo "(not pinned)"
echo "--- curl registries ---"
curl -4 -sS -m12 -o /dev/null -w "ghcr: %{http_code}\n" https://ghcr.io/v2/
curl -4 -sS -m12 -o /dev/null -w "registry: %{http_code}\n" https://registry-1.docker.io/v2/ || true
echo "--- node base image ---"
docker image inspect "\$NODE_IMAGE" >/dev/null
docker images "\$NODE_IMAGE" | head -2
echo "--- docker ghcr smoke ---"
docker pull ghcr.io/coollabsio/sentinel:0.0.21
echo "preflight OK"
REMOTE

echo "Spectre docker preflight passed"