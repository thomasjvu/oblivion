#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="clean-online-identity"
REPO="thomasjvu/oblivion"
BRANCH="${OBLIVION_SKILL_BRANCH:-main}"
DEFAULT_RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

usage() {
  cat <<EOF
Oblivion skill installer — ${SKILL_NAME}

Usage:
  bash skill.sh [options]

Options:
  -g, --global          Install to user home agent dirs instead of the current project
  -a, --agent <name>    Install only for one agent (repeatable): grok, cursor, claude-code, codex, opencode
  -y, --yes             Non-interactive; install to detected agents
  --base-url <url>      Override download base (no trailing slash)
  -h, --help            Show this help

Environment:
  OBLIVION_SKILL_BASE_URL   Same as --base-url
  OBLIVION_SKILL_BRANCH     Git branch for GitHub fallback (default: main)

Examples:
  curl -fsSL https://your-host/skill.sh | bash
  npx skills add ${REPO} --skill ${SKILL_NAME}
EOF
}

log() { printf 'oblivion-skill: %s\n' "$*"; }
die() { log "error: $*"; exit 1; }

GLOBAL=0
YES=0
BASE_URL="${OBLIVION_SKILL_BASE_URL:-}"
AGENTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -g|--global) GLOBAL=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -a|--agent)
      [[ $# -ge 2 ]] || die "--agent requires a value"
      AGENTS+=("$2")
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 ]] || die "--base-url requires a value"
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="$DEFAULT_RAW_BASE"
fi

BASE_URL="${BASE_URL%/}"

declare -A AGENT_DIRS=(
  [grok]=".grok/skills"
  [cursor]=".agents/skills"
  [claude-code]=".claude/skills"
  [codex]=".agents/skills"
  [opencode]=".agents/skills"
  [cline]=".agents/skills"
  [github-copilot]=".agents/skills"
)

detect_agents() {
  if [[ ${#AGENTS[@]} -gt 0 ]]; then
    printf '%s\n' "${AGENTS[@]}"
    return
  fi
  local found=()
  command -v cursor >/dev/null 2>&1 && found+=("cursor")
  [[ -d "${HOME}/.claude" ]] && found+=("claude-code")
  [[ -d "${HOME}/.codex" || -d "${HOME}/.config/codex" ]] && found+=("codex")
  [[ -d "${HOME}/.grok" ]] && found+=("grok")
  [[ -d "${HOME}/.config/opencode" ]] && found+=("opencode")
  if [[ ${#found[@]} -eq 0 ]]; then
    found=("grok" "cursor" "claude-code" "codex")
  fi
  printf '%s\n' "${found[@]}" | awk '!seen[$0]++'
}

fetch_manifest_files() {
  local manifest_url="${BASE_URL}/skills/${SKILL_NAME}/manifest.json"
  if ! curl -fsSL "$manifest_url" -o /tmp/oblivion-skill-manifest.json 2>/dev/null; then
    manifest_url="${DEFAULT_RAW_BASE}/skills/${SKILL_NAME}/manifest.json"
    curl -fsSL "$manifest_url" -o /tmp/oblivion-skill-manifest.json
  fi
  python3 - <<'PY'
import json
with open("/tmp/oblivion-skill-manifest.json", "r", encoding="utf-8") as fh:
    data = json.load(fh)
for item in data.get("files", []):
    print(item)
PY
}

install_skill_tree() {
  local dest_root="$1"
  local dest="${dest_root}/${SKILL_NAME}"
  mkdir -p "$dest"
  local files
  files="$(fetch_manifest_files)"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    local url="${BASE_URL}/skills/${SKILL_NAME}/${file}"
    local out="${dest}/${file}"
    mkdir -p "$(dirname "$out")"
    if ! curl -fsSL "$url" -o "$out" 2>/dev/null; then
      url="${DEFAULT_RAW_BASE}/skills/${SKILL_NAME}/${file}"
      curl -fsSL "$url" -o "$out"
    fi
  done <<< "$files"
  log "installed ${SKILL_NAME} -> ${dest}"
}

root_for_scope() {
  if [[ "$GLOBAL" -eq 1 ]]; then
    printf '%s' "$HOME"
  else
    printf '%s' "$(pwd)"
  fi
}

mapfile -t TARGET_AGENTS < <(detect_agents)
[[ ${#TARGET_AGENTS[@]} -gt 0 ]] || die "no target agents selected"

if [[ "$YES" -eq 0 && -t 0 ]]; then
  log "base: ${BASE_URL}"
  log "agents: ${TARGET_AGENTS[*]}"
  log "scope: $([[ "$GLOBAL" -eq 1 ]] && echo global || echo project)"
  read -r -p "Install ${SKILL_NAME}? [y/N] " reply
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]] || exit 0
fi

for agent in "${TARGET_AGENTS[@]}"; do
  rel="${AGENT_DIRS[$agent]:-}"
  [[ -n "$rel" ]] || die "unsupported agent: ${agent}"
  install_skill_tree "$(root_for_scope)/${rel}"
done

log "done. Open your agent and invoke /${SKILL_NAME} or ask for identity cleanup help."
log "managed UI: start Oblivion for encrypted cases, approvals, and Trust Center attestation."