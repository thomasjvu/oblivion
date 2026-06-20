#!/usr/bin/env bash
set -euo pipefail

# Run on spectre.thomasjvu.com
#   bash ~/oblivion-ops/oblivion/examples/oblivion-development/spectre/bootstrap-agents.sh

OBLIVION_OPS="${OBLIVION_OPS:-$HOME/oblivion-ops}"
PARTY_QUEST_DIR="${PARTY_QUEST_DIR:-$HOME/party-quest}"
PHANTASY_AGENT_ROOT="${PHANTASY_AGENT_ROOT:-$HOME/oblivion-ops/phantasy-agent}"
OBLIVION_REPO="${OBLIVION_REPO:-$OBLIVION_OPS/oblivion}"
WORKSPACES="${OBLIVION_WORKSPACES:-$OBLIVION_OPS/workspaces}"
SEED_FILE="${OBLIVION_RUNTIME_SEED_FILE:-$OBLIVION_OPS/runtime-agent-seed.json}"
TEMPLATE_ROOT="${OBLIVION_REPO}/examples/oblivion-development/workspaces"

echo "==> Ensure Oblivion repo"
if [ ! -d "${OBLIVION_REPO}/.git" ]; then
  git clone https://forgejo.phantasy.bot/oblivion/oblivion.git "${OBLIVION_REPO}"
fi
git -C "${OBLIVION_REPO}" fetch origin main
git -C "${OBLIVION_REPO}" checkout main
git -C "${OBLIVION_REPO}" pull --ff-only origin main || true

echo "==> Ensure Phantasy agent checkout"
if [ ! -d "${PHANTASY_AGENT_ROOT}/.git" ]; then
  git clone https://github.com/phantasy-ai/phantasy.git "${PHANTASY_AGENT_ROOT}" 2>/dev/null || \
    cp -R "${HOME}/alkahest-ops/phantasy-agent" "${PHANTASY_AGENT_ROOT}"
fi

echo "==> Install Phantasy agent configs"
mkdir -p "${PHANTASY_AGENT_ROOT}/config/agents"
cp "${OBLIVION_REPO}/examples/oblivion-development/phantasy-agent-configs/"*.json \
  "${PHANTASY_AGENT_ROOT}/config/agents/" 2>/dev/null || true

echo "==> Ensure workspaces"
mkdir -p "${WORKSPACES}"/{phantasy,hermes,openclaw,opencode,env}
for framework in phantasy hermes openclaw opencode; do
  cp "${TEMPLATE_ROOT}/shared/AGENTS.md" "${WORKSPACES}/${framework}/AGENTS.md"
  cp "${TEMPLATE_ROOT}/shared/HEARTBEAT.md" "${WORKSPACES}/${framework}/HEARTBEAT.md"
  cp "${TEMPLATE_ROOT}/${framework}/party-quest.adapter.json" \
    "${WORKSPACES}/${framework}/party-quest.adapter.json"
done

echo "==> Forgejo agent users"
if [ -n "${FORGEJO_TOKEN:-}" ]; then
  FORGEJO_TOKEN="${FORGEJO_TOKEN}" WORKSPACE_ENV_DIR="${WORKSPACES}/env" \
    node "${OBLIVION_REPO}/scripts/setup-forgejo-agent-users.mjs"
else
  echo "warn: FORGEJO_TOKEN not set — skip agent user provisioning"
fi

echo "==> Seed Oblivion runtime agents + campaign"
cd "${PARTY_QUEST_DIR}"
set -a
source .env.self-hosted
set +a
SEED_JSON="$(npx convex run seed:seedOblivionRuntimeAgents)"
printf '%s\n' "${SEED_JSON}" > "${SEED_FILE}"
npx convex run seed:seedOblivionDevelopment
echo "Saved seed evidence: ${SEED_FILE}"

echo "==> Start agent runtimes"
cp "${OBLIVION_REPO}/examples/oblivion-development/spectre/docker-compose.agents.yml" \
  "${OBLIVION_OPS}/docker-compose.agents.yml"
cd "${OBLIVION_OPS}"
PHANTASY_AGENT_ROOT="${PHANTASY_AGENT_ROOT}" \
OBLIVION_REPO="${OBLIVION_REPO}" \
OBLIVION_WORKSPACES="${WORKSPACES}" \
  docker compose -f docker-compose.agents.yml up -d

echo "==> Wait for health"
for port in 2100 2101 2102 2103; do
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "  :${port} healthy"
      break
    fi
    sleep 2
  done
done

echo "==> Register agents"
OBLIVION_REPO="${OBLIVION_REPO}" \
OBLIVION_RUNTIME_SEED_FILE="${SEED_FILE}" \
  bash "${OBLIVION_REPO}/examples/oblivion-development/spectre/register-all-oblivion-agents.sh"

echo "==> Restart runtimes"
docker compose -f docker-compose.agents.yml restart

echo "Done. Dogfood: node ${OBLIVION_REPO}/scripts/dogfood-party-quest-oblivion.mjs --pause-bridges --reseed"