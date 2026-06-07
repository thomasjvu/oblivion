#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHALA_API_URL="${OBLIVION_PUBLIC_API_URL:-https://3a522af6627d93bb480ba7bd39d375a1535aefa8-8080.dstack-pha-prod5.phala.network}"
CF_UI_ORIGIN="${OBLIVION_CORS_ORIGIN:-https://oblivion.phantasy.bot}"
TAG="${OBLIVION_TAG:-$(git -C "$ROOT" rev-parse --short HEAD)-prod}"
ENV_FILE="${OBLIVION_ENV_FILE:-$ROOT/.env}"

echo "==> Sync app version into trust center"
npm run version:sync

echo "==> Build image on spectre ($TAG)"
OBLIVION_TAG="$TAG" OBLIVION_PUSH=1 bash "$ROOT/scripts/build-on-spectre.sh"

echo "==> Pin digest in compose + trust center"
npm run docker:pin -- "ghcr.io/thomasjvu/oblivion:$TAG"

echo "==> Deploy Phala CVM (secrets from $ENV_FILE)"
OBLIVION_PHALA_TAG="$TAG" \
  OBLIVION_PUBLIC_API_URL="$PHALA_API_URL" \
  OBLIVION_CORS_ORIGIN="$CF_UI_ORIGIN" \
  OBLIVION_ENV_FILE="$ENV_FILE" \
  bash "$ROOT/scripts/deploy-phala.sh"

echo "==> Sync trust center compose hash from live CVM"
npm run phala:sync-trust

echo "==> Rebuild + redeploy with synced trust center"
OBLIVION_TAG="${TAG}-trust" OBLIVION_PUSH=1 bash "$ROOT/scripts/build-on-spectre.sh"
npm run docker:pin -- "ghcr.io/thomasjvu/oblivion:${TAG}-trust"
OBLIVION_PHALA_TAG="${TAG}-trust" \
  OBLIVION_PUBLIC_API_URL="$PHALA_API_URL" \
  OBLIVION_CORS_ORIGIN="$CF_UI_ORIGIN" \
  OBLIVION_ENV_FILE="$ENV_FILE" \
  bash "$ROOT/scripts/deploy-phala.sh"

echo "==> Deploy Cloudflare Workers UI"
OBLIVION_API_ORIGIN="$PHALA_API_URL" bash "$ROOT/scripts/deploy-cloudflare-ui.sh"

echo ""
echo "Production URLs:"
echo "  API (Phala):  $PHALA_API_URL"
echo "  UI (CF):      $CF_UI_ORIGIN"
echo "  Health:       $PHALA_API_URL/health"
echo "  Attestation:  $PHALA_API_URL/api/trust/attestation"