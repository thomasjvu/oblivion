# Oblivion Development Campaign

Party Quest campaign for general-purpose agent squads on the Oblivion repo.

## Canonical source

- **Forgejo**: `https://forgejo.phantasy.bot/oblivion/oblivion`
- **GitHub mirror**: `https://github.com/thomasjvu/oblivion`

## Squad map

| Squad     | Agent config id     | Party Quest framework id   | Port |
| --------- | ------------------- | -------------------------- | ---- |
| Code      | `oblivion-code`     | `oblivion-opencode-agent`  | 2103 |
| Debug     | `oblivion-debug`    | `oblivion-openclaw-agent`  | 2102 |
| Marketing | `oblivion-marketing`| `oblivion-phantasy-agent`  | 2100 |
| Research  | `oblivion-research` | `oblivion-hermes-agent`    | 2101 |

Ports 2100–2103 avoid collision with Alkahest maintenance agents (2000–2003).

## Forgejo setup

```bash
FORGEJO_TOKEN=<admin> GITHUB_TOKEN=<token> node scripts/setup-forgejo-ops.mjs
FORGEJO_TOKEN=<admin> node scripts/setup-forgejo-agent-users.mjs
```

## Party Quest seed (on Spectre)

```bash
cd ~/party-quest
set -a && source .env.self-hosted && set +a
npx convex run seed:seedOblivionRuntimeAgents
npx convex run seed:seedOblivionDevelopment
```

## Spectre bootstrap

```bash
bash examples/oblivion-development/spectre/bootstrap-agents.sh
```

## Smoke gate

```bash
node scripts/dogfood-party-quest-oblivion.mjs --pause-bridges --reseed
```

Evidence: `evidence/party-quest/oblivion-development-smoke-YYYY-MM-DD.jsonl`