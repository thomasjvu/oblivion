# Oblivion Security Model

Oblivion is designed to minimize what users must trust, but it cannot make third-party identity cleanup anonymous. Data brokers, search engines, controllers, and breach-check services may receive identifiers when the user approves a specific action.

## Managed Oblivion

Managed Oblivion adds controls that a portable skill cannot guarantee on its own:

- Client-side encryption before case persistence.
- Server-side storage of ciphertext plus minimal redacted metadata.
- Policy enforcement before LLM/tool use.
- Phala Confidential VM deployment target.
- Public Trust Center metadata for attestation, compose hash, image digests, source commit, and deployment version.
- Live Phala attestation through the dstack guest agent socket (`/var/run/dstack.sock`) via `@phala/dstack-sdk`, with optional HTTP fallback through `PHALA_ATTESTATION_URL`.
- Intel TDX quote verification through Phala's verifier endpoint.
- Client-side blocking for sensitive actions unless Trust Center status is passing.
- Record-only default executor until external connectors are explicitly integrated behind approval gates.

## Installable Skill

The installable skill at `skills/clean-online-identity/SKILL.md` (also served at `/skills/clean-online-identity/SKILL.md`) is a portable workflow for other agents. It defines safety rules, output contracts, approval standards, and data-minimization guidance. It does not by itself prove that the host agent, logs, plugins, or model provider are private.

## Never Store

- Passwords.
- Full SSNs.
- Full government ID numbers.
- Payment card data.
- Account recovery codes.
- Unredacted identity documents.
- Unredacted high-risk current address evidence unless specifically required and encrypted.

## Approval Boundary

Every sensitive action must bind:

- Destination.
- Action type.
- Identifier categories.
- Data categories disclosed.
- Purpose.
- Disclosure risk.
- Expiration.
- User confirmation.

Broad consent is not enough. The system converts broad intent into concrete approval records.

## Production Requirements

- Replace placeholder Trust Center values with live Phala attestation evidence.
- Mount `/var/run/dstack.sock` in the production compose file (see `docker-compose.phala.yml`).
- Run `npm run phala:sync-trust` after deploy to pin `expectedComposeHash` in `config/trust-center.json`, then rebuild and redeploy.
- Optionally set `PHALA_ATTESTATION_URL` as an HTTP fallback attestation endpoint.
- Confirm `GET /api/trust/attestation` returns `verifierResult: "pass"` before accepting sensitive tasks.
- Pin every production image by `@sha256:` digest.
- Store operator secrets in Infisical (`secret-management` project), sync to gitignored `.env.production`, then inject into Phala via `scripts/deploy-phala.sh -e .env.production`. Never commit `.env`, `.env.production`, or `.env.infisical`.
- Disable plaintext logs and request tracing.
- Add external adapters only after tests prove blocked execution without matching approval.

## Production Runbook

1. **Build and pin** — `npm run docker:build:remote` (or local build), then `npm run docker:pin -- ghcr.io/thomasjvu/oblivion@sha256:<digest>`.
2. **Pull secrets** — `npm run secrets:pull:prod` (Infisical → `.env.production`). `npm run deploy:production` does this automatically unless `OBLIVION_SKIP_SECRETS_PULL=1`.
3. **Deploy CVM** — `npm run phala:deploy` with secrets via `scripts/deploy-phala.sh -e .env.production` (never commit env files).
4. **Sync trust** — `npm run phala:sync-trust` copies the live compose hash into `config/trust-center.json` and updates `sourceCommit`.
5. **Rebuild trust image** — bake the synced `config/trust-center.json` into a `-prod-trust` image and redeploy so the CVM serves matching metadata.
6. **Verify attestation** — `curl -s $API/api/trust/attestation | jq '.verifierResult, .composeHashMatches, .hardwareQuoteVerified'` must show `pass`, `true`, `true`.
7. **Check integrations** — `GET /api/integrations/status` lists `liveReady.*` for configured adapters only.
8. **Live executor** — production profile (`OBLIVION_DEPLOYMENT_ENV=production`) enables `OBLIVION_EXECUTOR_MODE=live` by default. Managed-plaintext connectors still require `verifierResult: "pass"`.
9. **Never enable `OBLIVION_AI_BYPASS_PAYMENT` in production** — Venice chat/analysis requires a paid x402 session per case.
10. **Rotate 1Shot credentials after HMAC deploy** — issue a new `ONESHOT_API_KEY` in the 1Shot dashboard, `npm run secrets:push:prod`, redeploy the CVM, then revoke the previous key. Confirms plan 035 webhook verification is live with fresh secrets.

### Infisical secret workflow

Infisical stores **API keys and deploy URLs only** (~6 keys in `dev`, ~10 in `prod`). Runtime profile defaults (x402 network/facilitator, executor mode, wallet chain, file store, plaintext log suppression) are derived from `OBLIVION_DEPLOYMENT_ENV` in `src/domain/deploymentEnv.ts`. The app reads `process.env` at runtime — no Infisical SDK in the server.

| Item | Value |
|------|-------|
| Instance | `https://infisical.phantasy.bot` |
| Project | `baa5ece8-bf19-441b-96f9-5d3f6affd104` (`secret-management`) |
| Environments | `dev` → `.env`, `prod` → `.env.production` |
| Allowlists | `scripts/lib/secrets-config.mjs` (`DEV_SYNC_KEYS`, `PROD_SYNC_KEYS`) |

Bootstrap (one-time):

```bash
cloudflared access login https://infisical.phantasy.bot
cp .env.infisical.example .env.infisical   # add machine identity credentials
source .env.infisical
npm run secrets:bootstrap                  # prune legacy keys, push allowlist, pull clean env files
npm run secrets:doctor
```

Day-to-day:

```bash
npm run secrets:pull:prod
OBLIVION_ENV_FILE=.env.production npm run deploy:production
```

### Infisical-managed keys

| Key | Environment | Enables |
|-----|-------------|---------|
| `BRAVE_SEARCH_API_KEY` | dev, prod | Exposure web search |
| `VENICE_API_KEY` | dev, prod | Agent AI + fallback search |
| `ONESHOT_API_KEY` | dev, prod | 1Shot JSON-RPC relay |
| `X402_PAY_TO` | dev, prod | x402 payout wallet |
| `OBLIVION_PUBLIC_API_URL` | dev, prod | 1Shot webhook origin (Phala hostname in prod) |
| `OBLIVION_CORS_ORIGIN` | dev, prod | Cloudflare Workers UI origin |
| `HIBP_API_KEY` | prod | Live breach email check (TEE-gated) |
| `X402_CDP_API_KEY_ID` / `SECRET` | prod | CDP x402 settlement on Base mainnet |
| `PHALA_ATTESTATION_URL` | prod | Live TDX quote endpoint (often set by compose) |
| Partner / email keys | prod (optional) | B2B rail and live email connectors |

## User-Facing Claim

Use precise wording:

> Oblivion cannot read your stored case vault. Sensitive data is encrypted in your browser before storage. For approved actions that require plaintext, data is decrypted only in your browser or inside an attested TEE task for that specific action.

Avoid absolute wording such as "we never touch data" because approved third-party submissions still disclose the user's approved identifiers to brokers, controllers, search engines, or breach-check services.

## Consumer API Authentication

The browser app and direct `/api/*` integrations use **case access tokens**, not user accounts.

1. `POST /api/cases` returns `{ case, accessToken, status }`. The token is shown **once**; store it in the browser (`localStorage` key `oblivion.caseTokens`) or your integration secret store.
2. All other consumer case routes require `Authorization: Bearer <accessToken>`:
   - `/api/cases/:id/*` (read, intake, preset, plan, discover, agent run, preferences, export, delete)
   - `/api/actions/*`, `/api/approvals/*` when acting on a consumer case
   - `/api/export`, `/api/delete` with `{ caseId }` in the body
3. `accessTokenHash` is stored server-side only; API responses never include the hash or a re-issued token.
4. `GET /api/cases` is **not** an open case listing — it returns `401 case-list-not-available`. The client keeps case summaries in local storage and refreshes individual cases with the token.
5. Partner-scoped cases (`partnerId` set) **must** use `/v1/*` with a partner API key. Consumer `/api/*` returns `403 partner-case-use-v1-api`.

Treat `caseId` + `accessToken` together as a capability credential. Do not log tokens, embed them in URLs, or expose them in referrers. Rotate by creating a new case if a token is compromised (there is no server-side rotation endpoint for consumer tokens today).

### Wallet index and recovery kit

- `GET /api/wallet/cases` returns only redacted summaries (`caseId`, `personLabel`, timestamps) for a `walletKey` — never `accessToken` or vault plaintext.
- `POST /api/wallet/cases/link` requires a valid case Bearer token plus `walletAddress`; it sets `activatedWalletKey` for cross-device lookup.
- Recovery kits are **client-side exports** (`caseId`, `accessToken`, optional passphrase-wrapped vault key). Operators must not add server endpoints that store or re-issue raw tokens.

### Discovery preview

- `POST /api/discovery/preview` accepts redacted labels only (no email/phone), does not create cases or store intake, and is rate-limited per IP/wallet.
- Preview quota keys off socket `remoteAddress` by default. Set `OBLIVION_TRUST_PROXY=true` only when the app sits behind a reverse proxy that strips spoofed `X-Forwarded-For` and sets the header to the real client IP.
- Full `POST /api/cases/:id/findings/discover` requires case activation and debits wallet discovery credits when broker sweep runs.

## Partner API (B2B)

Embedded partners (password managers, VPNs, security suites) integrate via `/v1/*` with Bearer API keys. Partner servers must **not** decrypt `encryptedIntake` or approve disclosures on behalf of users.

- Partner cases carry `partnerId` + `externalRef`; all `/v1/cases/:id/*` routes require matching partner API key via `assertPartnerOwnsCase`.
- Partner cases are **blocked** on consumer `/api/*` even if `caseId` is known.
- Partners receive redacted scope, exposure URLs, approval metadata, and signed webhooks.
- Plaintext transits only from the **user browser** in an approved execute handoff.
- No "trusted partner" auto-approve bypass — same policy gates as the consumer app.

See the [Partner API](https://oblivion-docs.phantasy.bot/docs/developers/partner-api).

## Hackathon / Demo Routes

`/api/hackathon/*` and related sponsor-track helpers are **disabled by default** in production. Set `HACKATHON_MODE=true` only on demo hosts. Core case lifecycle, trust, and billing routes are unaffected.
