#!/usr/bin/env bash
set -euo pipefail

# Re-apply oblivion quest workflow paths and run dogfood on spectre.
OBLIVION_REPO="${OBLIVION_REPO:-$HOME/oblivion-ops/oblivion}"
PARTY_QUEST_DIR="${PARTY_QUEST_DIR:-$HOME/party-quest}"

git -C "${OBLIVION_REPO}" pull --ff-only origin main || true

cd "${PARTY_QUEST_DIR}"
set -a
source .env.self-hosted
set +a
npx convex run seed:seedOblivionDevelopment

bash "${OBLIVION_REPO}/examples/oblivion-development/spectre/start-agents.sh"
node "${OBLIVION_REPO}/scripts/dogfood-party-quest-oblivion.mjs" --pause-bridges --reseed