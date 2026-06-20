#!/usr/bin/env bash
set -euo pipefail

PHANTASY_AGENT_ROOT="${PHANTASY_AGENT_ROOT:-$HOME/oblivion-ops/phantasy-agent}"
ENV_DIR="${OBLIVION_AGENT_ENV_DIR:-$HOME/oblivion-ops/workspaces/env}"
LOG_DIR="${OBLIVION_LOG_DIR:-$HOME/oblivion-ops/logs}"

mkdir -p "${LOG_DIR}" "${ENV_DIR}"

agents=(
  "2100:oblivion-marketing"
  "2101:oblivion-research"
  "2102:oblivion-debug"
  "2103:oblivion-code"
)

cd "${PHANTASY_AGENT_ROOT}"

for spec in "${agents[@]}"; do
  port="${spec%%:*}"
  agent="${spec##*:}"
  env_file="${ENV_DIR}/${agent}.env"

  if curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "healthy ${agent} :${port}"
    continue
  fi

  (
    export AGENT_ID="${agent}"
    export AGENT_FRAMEWORK_URL="http://127.0.0.1:${port}"
    export PARTY_QUEST_ENABLE_ASSIGNMENTS=true
    export PARTY_QUEST_AUTO_RUN_WORKFLOWS=true
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
    export PORT="${port}"
    exec node dist/server.js
  ) > "${LOG_DIR}/${agent}.log" 2>&1 &

  echo "started ${agent} :${port}"
done