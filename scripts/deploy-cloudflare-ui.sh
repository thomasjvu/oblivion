#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_ORIGIN="${OBLIVION_API_ORIGIN:-https://3a522af6627d93bb480ba7bd39d375a1535aefa8-8080.dstack-pha-prod5.phala.network}"
UI_HOST="${OBLIVION_UI_HOST:-oblivion.phantasy.bot}"

cd "$ROOT"
npm run build:client
npm run build:fonts
npm run build:legal

cd "$ROOT/workers"
OBLIVION_API_ORIGIN="$API_ORIGIN" wrangler deploy --config wrangler.toml \
  --var "OBLIVION_API_ORIGIN:$API_ORIGIN"

echo "Workers UI deployed. Route: https://$UI_HOST (configure DNS if not already routed)."