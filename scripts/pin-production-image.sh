#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 ghcr.io/owner/oblivion@sha256:<64-hex>" >&2
  exit 1
fi

IMAGE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "Image must be digest-pinned: $IMAGE" >&2
  exit 1
fi

COMPOSE_FILE="$ROOT/docker-compose.phala.yml"
TRUST_CENTER="$ROOT/config/trust-center.json"
COMPOSE_TAG="${OBLIVION_COMPOSE_TAG:-}"

if [[ -n "$COMPOSE_TAG" ]]; then
  PIN_IMAGE="ghcr.io/thomasjvu/oblivion:$COMPOSE_TAG" perl -0pi -pe 's|^(\s*image:\s*).*$|$1$ENV{PIN_IMAGE}|' "$COMPOSE_FILE"
else
  PIN_IMAGE="$IMAGE" perl -0pi -pe 's|^(\s*image:\s*).*$|$1$ENV{PIN_IMAGE}|' "$COMPOSE_FILE"
fi

node --input-type=module -e "
import { readFile, writeFile } from 'node:fs/promises';
const path = process.argv[1];
const image = process.argv[2];
const config = JSON.parse(await readFile(path, 'utf8'));
config.imageDigests = [image];
await writeFile(path, JSON.stringify(config, null, 2) + '\\n', 'utf8');
" "$TRUST_CENTER" "$IMAGE"

if [[ -n "$COMPOSE_TAG" ]]; then
  echo "Pinned $IMAGE in config/trust-center.json; compose image tag set to $COMPOSE_TAG"
else
  echo "Pinned $IMAGE in docker-compose.phala.yml and config/trust-center.json"
fi