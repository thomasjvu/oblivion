#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBLIVION_REPO="${OBLIVION_REPO:-$HOME/oblivion-ops/oblivion}"
AGENT_ROOT="${PHANTASY_AGENT_ROOT:-$HOME/oblivion-ops/phantasy-agent}"
SEED_EVIDENCE="${OBLIVION_RUNTIME_SEED_FILE:-$HOME/oblivion-ops/runtime-agent-seed.json}"
ENV_DIR="${OBLIVION_AGENT_ENV_DIR:-$HOME/oblivion-ops/workspaces/env}"

OBLIVION_AGENTS=(
  "oblivion-marketing:oblivion-phantasy-agent"
  "oblivion-research:oblivion-hermes-agent"
  "oblivion-debug:oblivion-openclaw-agent"
  "oblivion-code:oblivion-opencode-agent"
)

PORT_MAP=(
  "oblivion-phantasy-agent:2100"
  "oblivion-hermes-agent:2101"
  "oblivion-openclaw-agent:2102"
  "oblivion-opencode-agent:2103"
)

port_for_framework() {
  local framework_id="$1"
  for entry in "${PORT_MAP[@]}"; do
    if [ "${entry%%:*}" = "${framework_id}" ]; then
      echo "${entry##*:}"
      return 0
    fi
  done
  echo "2100"
}

mkdir -p "${ENV_DIR}"
cd "${AGENT_ROOT}"
export PARTY_QUEST_URL="${PARTY_QUEST_URL:-https://party-convex-site.phantasy.bot}"

for entry in "${OBLIVION_AGENTS[@]}"; do
  agent="${entry%%:*}"
  framework_id="${entry##*:}"
  config="${AGENT_ROOT}/config/agents/${agent}.json"
  env_file="${ENV_DIR}/${agent}.env"
  port="$(port_for_framework "${framework_id}")"

  if [ ! -f "${config}" ]; then
    src="${OBLIVION_REPO}/examples/oblivion-development/phantasy-agent-configs/${agent}.json"
    if [ -f "${src}" ]; then
      mkdir -p "$(dirname "${config}")"
      cp "${src}" "${config}"
    else
      echo "warn: missing config for ${agent}"
      continue
    fi
  fi

  agent_bootstrap_token=""
  if [ -f "${SEED_EVIDENCE}" ]; then
    agent_bootstrap_token="$(node -e '
const fs = require("node:fs");
const frameworkId = process.argv[1];
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const match = (payload.agents || []).find((entry) => entry.agentFrameworkId === frameworkId);
process.stdout.write(match?.bootstrapToken || "");
' "${framework_id}" "${SEED_EVIDENCE}")"
  fi

  echo "==> Register ${agent} (${framework_id}) on :${port}"
  if [ -n "${agent_bootstrap_token}" ]; then
    AGENT_FRAMEWORK_URL="http://127.0.0.1:${port}" \
      PARTY_QUEST_BOOTSTRAP_TOKEN="${agent_bootstrap_token}" \
      PARTY_QUEST_API_KEY="" \
      PARTY_QUEST_WEBHOOK_SECRET="" \
      npm run party-quest:onboard -- --agent "${agent}" --env-file "${env_file}" --skip-heartbeat
  else
    AGENT_FRAMEWORK_URL="http://127.0.0.1:${port}" \
      npm run party-quest:onboard -- --agent "${agent}" --env-file "${env_file}" --skip-heartbeat
  fi
done

echo "Done. Run: cd ~/party-quest && npx convex run seed:seedOblivionDevelopment"