# Oblivion

**Personal information removal without giving away your personal information.**

Supervised agent for people-search cleanup, breach awareness, and search suppression. Sensitive identifiers are encrypted in the browser; the server stores ciphertext and redacted metadata only. Nothing is sent externally without explicit approval.

Also a **partner API** for embedding broker removal in other products — see the [Partner API](https://oblivion-docs.phantasy.bot/docs/developers/partner-api).

## Quick start

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:8080 · [User guide](https://oblivion-docs.phantasy.bot/docs/user-guide/overview)

```sh
npm run verify   # build + test + typecheck
```

## How it works

- **Browser vault** — raw identifiers never leave the client unencrypted.
- **Approvals** — propose → policy check → your confirmation → execute.
- **TEE gate** — sensitive connectors require attestation pass in production.
- **Record-only default** — live connectors are policy-gated; see `AGENTS.md` for invariants.

Full lifecycle, presets, and security model: [docs site](https://oblivion-docs.phantasy.bot) · [`SECURITY.md`](SECURITY.md) · [`AGENTS.md`](AGENTS.md)

## Secrets

API keys and deploy URLs live in [Infisical](https://infisical.phantasy.bot/organizations/3f80ae72-bc03-474a-8b14-108b3bb2dbf4/projects/secret-management/baa5ece8-bf19-441b-96f9-5d3f6affd104/overview) (`dev` → `.env`, `prod` → `.env.production`). Profile defaults (x402 network, executor mode, chain IDs) are derived in `src/domain/deploymentEnv.ts` — not stored in the vault.

```sh
cloudflared access login https://infisical.phantasy.bot
cp .env.infisical.example .env.infisical   # machine identity
source .env.infisical
npm run secrets:pull:dev                   # ~6 managed keys → .env
npm run secrets:pull:prod                  # ~10 managed keys → .env.production
npm run secrets:doctor
```

## Deploy

```sh
OBLIVION_ENV_FILE=.env.production npm run deploy:production
```

`deploy:production` pulls prod secrets from Infisical first (set `OBLIVION_SKIP_SECRETS_PULL=1` to skip).

Builds on spectre, deploys Phala CVM, syncs trust center, deploys Cloudflare UI. Details: [`SECURITY.md` § Production runbook](SECURITY.md#production-runbook).

Local Docker: `npm run docker:build` · `npm run docker:run`

## Partner API

```sh
# .env: OBLIVION_PARTNER_KEYS=acme:obl_live_your_secret_key
curl -X POST http://localhost:8080/v1/cases \
  -H "Authorization: Bearer obl_live_your_secret_key" \
  -H "Content-Type: application/json" \
  -d '{"jurisdiction":"US","authorityBasis":"self","externalRef":"user_123"}'
```

[`spec/openapi-v1.yaml`](spec/openapi-v1.yaml) · [`packages/vault-sdk/`](packages/vault-sdk/) · [`packages/partner-sdk/`](packages/partner-sdk/) · [onboarding runbook](https://oblivion-docs.phantasy.bot/docs/developers/partner-onboarding)

## Repo map

| Path | What |
|------|------|
| `src/` | Node HTTP API, policy, agent runner, attestation |
| `public/` | Browser UI |
| `packages/` | Vault + partner SDKs |
| `docs/` | Documentation site (`npm run docs:dev`) |
| `DESIGN.md` | Visual language |

**Live:** [oblivion.phantasy.bot](https://oblivion.phantasy.bot) · **Docs:** [oblivion-docs.phantasy.bot](https://oblivion-docs.phantasy.bot)