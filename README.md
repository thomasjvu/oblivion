# Oblivion

**Personal information removal without giving away your personal information.**

Private supervised agent for people-search cleanup, breach awareness, and search suppression. Encrypted in the browser. Server stores only ciphertext + redacted metadata. Every disclosure stops at an explicit approval gate.

**For app builders:** Oblivion is also a partner API — embed broker removal in password managers, VPNs, and security products without holding user PII. See the [Partner API](https://oblivion-docs.phantasy.bot/docs/developers/partner-api) on the docs site.

## Quick Start

```sh
npm install
cp .env.example .env   # then fill in API keys and wallet addresses
npm run dev
```

Open http://localhost:8080.

**New here?** Read the [user guide](https://oblivion-docs.phantasy.bot/docs/user-guide/overview). Local dev still redirects `/help` to the docs site.

```sh
npm run verify   # build:client + test + typecheck + design:lint
npm test
npm run e2e
```

## Agent Lifecycle (record-only until TEE pass)

```mermaid
flowchart TD
    A[POST /api/cases<br/>jurisdiction + authorityBasis] --> A2[Store accessToken once<br/>Bearer on all case routes]
    A2 --> B[Encrypt intake in browser vault<br/>AES-256-GCM only]
    B --> C[POST /preset<br/>e.g. people-search-cleanup]
    C --> D[AgentPlan created<br/>visualNodes + currentStep]
    D --> E{verify-trust<br/>TEE attestation pass?}
    E -->|no| F[Local/record-only only<br/>runtimeGuard blocks hibp-email etc]
    E -->|yes| G[discover-candidates<br/>approved connectors]
    G --> H[confirm-matches<br/>user decision or blocked]
    H --> I[verify-removal-path<br/>Google / DROP / GDPR template]
    I --> J[draft-actions]
    J --> K[request-approval<br/>proposeApprovedAction]
    K --> L{explicit approve?<br/>userConfirmation + canExecute}
    L -->|no| M[Blocked. No disclosure.]
    L -->|yes| N[execute-approved-action<br/>record-only stub OR live in TEE]
    N --> O[schedule-recheck + followUps]
    O --> P[complete or escalate]
    style F fill:#ffd37a
    style M fill:#ff8a7a
    style L fill:#b9ff68
```

Record-only executor by default. Live paths gated behind policy + attestation + approval.

## Trust Model

- Vault: client-side only. Server cannot decrypt.
- Actions: propose → policy check → Approval record (dest, identifiers, dataToDisclose, purpose, risk, expiry) → explicit userConfirmation → canExecuteWithApproval → execute.
- Sensitive: assertSensitiveExecutionAllowed requires verifierResult: "pass" (Phala TDX quote, pinned images, compose match, fresh).
- Redaction + safe logging on every timeline, export, connector result, and log.
- Approved disclosures still go to third parties (broker, controller, HIBP, Google). The model minimizes infrastructure trust and prevents broad consent.

## What Works Locally

- All 6 presets, approval-gated and high-autonomy batch plans.
- Encrypted intake, redacted scope, policy blocks (SSN, password, dark web terms, source verification).
- **Exposure discovery**: paste profile URLs and/or Brave Search (`BRAVE_SEARCH_API_KEY`) + Venice/heuristic match scoring; confirm or reject each link before opt-out drafting.
- Safe HIBP prefix range check, Google removal plan, California DROP guidance, GDPR templates.
- Record-only execution by default (`OBLIVION_EXECUTOR_MODE=live` for connector handoff paths). Broker opt-outs are drafted, approved, then recorded—not silently deleted site-wide.
- Hackathon adapters (MetaMask EIP-7702/ERC-7715, x402 + ERC-7710, Venice redacted AI, A2A delegation, 1Shot relay) behind the same gates — enable with `HACKATHON_MODE=true` (off by default).
- Trust Center + `/api/trust/attestation` (not-configured locally; passes in Phala CVM with dstack socket + pinned trust center).

## Production / Phala

See `docker-compose.phala.yml`, `Dockerfile`, `config/trust-center.json`, and `SECURITY.md`.

```sh
# Build on spectre (rsync + docker build; GHCR push optional on server):
npm run docker:build:remote

# Local-only:
npm run docker:build
npm run docker:run

# After push to GHCR, pin digest in compose + trust center:
npm run docker:pin -- ghcr.io/thomasjvu/oblivion@sha256:<digest>

# Sync compose hash from live Phala CVM into trust-center.json:
npm run phala:sync-trust
```

Required env for TEE-enabled:

```sh
TRUST_CENTER_PATH=...
PHALA_ATTESTATION_URL=...
OBLIVION_EXECUTOR_MODE=record-only
OBLIVION_DISABLE_PLAINTEXT_LOGS=true
```

Confirm `GET /api/trust/attestation` returns `verifierResult: "pass"` before enabling sensitive connectors.

### Deployment environments

| `OBLIVION_DEPLOYMENT_ENV` | x402 network | Wallet chain | Facilitator default |
|---------------------------|--------------|--------------|---------------------|
| `development` (local default) | Base Sepolia `eip155:84532` | Ethereum Sepolia `11155111` | [x402.org testnet](https://x402.org/facilitator) |
| `production` (Phala default) | Base mainnet `eip155:8453` | Base `8453` | CDP `api.cdp.coinbase.com/.../x402` |

Override any default with explicit `X402_NETWORK`, `X402_FACILITATOR_URL`, or `WALLET_CHAIN_ID`. Production template: [`.env.production.example`](.env.production.example).

```sh
# Local dev
OBLIVION_DEPLOYMENT_ENV=development

# Phala / mainnet deploy
OBLIVION_ENV_FILE=.env.production npm run deploy:production
```

Optional hackathon wallet (MetaMask Smart Account demo / live Sepolia in development):

```sh
WALLET_LIVE_MODE=true          # enable wallet_sendCalls upgrade path in the browser
```

### Live integrations (hackathon + production)

Copy [`.env.example`](.env.example) to `.env` and configure:

| Variable | Purpose |
|----------|---------|
| `BRAVE_SEARCH_API_KEY` | People-search URL discovery (redacted query from case labels) |
| `VENICE_API_KEY` | Live agent classify / draft / review / chat + match scoring |
| `X402_PAY_TO` + facilitator | Dev: x402.org + Base Sepolia. Prod: CDP + Base mainnet (`X402_CDP_API_KEY_*`) |
| `ONESHOT_BASE_URL` | 1Shot public relayer JSON-RPC (default `https://relayer.1shotapi.com/relayers`) |
| `HIBP_API_KEY` | Live breach email check (TEE attestation pass required) |
| `OBLIVION_EXECUTOR_MODE=live` | Run approved connectors after policy + approval (still gated by TEE for managed plaintext) |
| `PHALA_ATTESTATION_URL` | Optional HTTP fallback for TDX quote fetch (primary path: dstack socket in CVM) |

Check readiness: `GET /api/integrations/status` · x402 buyer config: `GET /api/x402/config`

Broker web-form field mapping: `BROKER_WEBFORM_AUTOMATION=true` (probe only; submission still approval-gated).

Venice chat/classify requires a **paid** x402 session per case unless `OBLIVION_AI_BYPASS_PAYMENT=true` (dev/test only).

### Production deploy checklist

1. `npm run deploy:production` — build, pin digest, deploy Phala CVM, sync trust, rebuild `-prod-trust` image.
2. Confirm `GET /api/trust/attestation` → `verifierResult: "pass"`.
3. Load integration secrets via `scripts/deploy-phala.sh -e .env` (see `.env.example`).
4. Optionally set `OBLIVION_EXECUTOR_MODE=live` after attestation passes and secrets are wired.
5. Deploy UI: `npm run deploy:cloudflare-ui`.

Full runbook: [`SECURITY.md`](SECURITY.md#production-runbook).

## Partner API (B2B rail)

```sh
# .env
OBLIVION_PARTNER_KEYS=acme:obl_live_your_secret_key
```

```sh
curl -X POST http://localhost:8080/v1/cases \
  -H "Authorization: Bearer obl_live_your_secret_key" \
  -H "Content-Type: application/json" \
  -d '{"jurisdiction":"US","authorityBasis":"self","externalRef":"user_123"}'
```

- [Partner API](https://oblivion-docs.phantasy.bot/docs/developers/partner-api) — integration guide
- [`spec/openapi-v1.yaml`](spec/openapi-v1.yaml) — OpenAPI sketch (also at `/docs/openapi-v1.yaml` on the API)
- [`examples/partner-demo/`](examples/partner-demo/) — minimal partner app
- [`packages/vault-sdk/`](packages/vault-sdk/) — browser vault helpers (`npm run build:vault-sdk`)
- [`packages/partner-sdk/`](packages/partner-sdk/) — `@oblivion/partner-sdk` (billing, retries, audit helpers)
- [`packages/partner-ui/`](packages/partner-ui/) — embeddable approval + status widgets
- [Partner onboarding](https://oblivion-docs.phantasy.bot/docs/developers/partner-onboarding) — 30-min design-partner runbook
- Live demo: [/examples/partner-demo/](http://localhost:8080/examples/partner-demo/index.html) when `npm run dev` is running

Partner cases are scoped by API key on `/v1/*` only. Consumer UI cases use `/api/*` with a per-case `accessToken` returned at creation (`Authorization: Bearer …` on every case route).

## Docs

- [User guide](https://oblivion-docs.phantasy.bot/docs/user-guide/overview) — step-by-step guide for users.
- [Templates](https://oblivion-docs.phantasy.bot/docs/user-guide/templates) — every cleanup template/preset: workflow, connectors, approvals, and timelines.
- `AGENTS.md` — for AI agents and maintainers (invariants, safety checklists, test gaps, how to add connectors).
- `DESIGN.md` — visual language, colors, components.
- `SECURITY.md` — never-store rules, approval boundary, production requirements.
- [Hackathon demo](https://oblivion-docs.phantasy.bot/docs/developers/hackathon-demo) — architecture diagram, live-vs-demo matrix, judge flow, and per-track verification.
- `docs/` — [papers](https://github.com/thomasjvu/papers) documentation site (`npm run docs:dev`, deploys to https://oblivion-docs.phantasy.bot). See `docs/PAPERS_UPSTREAM.md` for framework sync.

## API Surface (core)

| Surface | Auth | Entry |
|---------|------|-------|
| Consumer `/api/*` | Case access token (except `POST /api/cases`, trust, presets, health) | `src/api/routes/consumer.ts` |
| Partner `/v1/*` | Partner API key | `src/api/routes/v1.ts` |
| Static + docs redirects | None | `src/api/static.ts`, `src/api/app.ts` |

Shared case handlers: `src/api/handlers/caseHandlers.ts`. All disclosure paths enforce policy + approval gates. See [SECURITY.md](SECURITY.md#consumer-api-authentication).
