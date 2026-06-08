# Oblivion Partner API

Personal information removal without giving away personal information — embed broker cleanup in your app without becoming a data custodian.

Oblivion is the **removal rail**. You keep the customer relationship. Raw identifiers stay in the **user's browser vault** (AES-256-GCM). Your servers receive `caseId`, redacted labels, exposure URLs, and lifecycle webhooks only.

## Quick start

1. Set partner keys on the Oblivion server:

```sh
OBLIVION_PARTNER_KEYS=acme:obl_live_your_secret_key
OBLIVION_PARTNER_DEFAULT_CREDITS=1000
```

2. Register a webhook (HTTPS required):

```sh
curl -X POST https://api.oblivion.example/v1/webhooks \
  -H "Authorization: Bearer obl_live_your_secret_key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-app.com/webhooks/oblivion","secret":"whsec_..."}'
```

3. Create a case from your backend:

```sh
curl -X POST https://api.oblivion.example/v1/cases \
  -H "Authorization: Bearer obl_live_your_secret_key" \
  -H "Content-Type: application/json" \
  -d '{"jurisdiction":"US","authorityBasis":"self","externalRef":"user_12345"}'
```

4. In the **user's browser** (WebView or your frontend), load `@oblivion/vault-sdk`, encrypt intake, and POST to `/v1/cases/:id/intake`. Never send plaintext PII from your server.

5. Drive the workflow with `/v1/cases/:id/preset`, `/discover`, `/run`. Surface approval cards to the **end user** — they must type `userConfirmation` (≥8 chars). Your API key cannot approve on their behalf.

See `examples/partner-demo/index.html` for a minimal integration.

## Trust boundaries

| Layer | Partner sees | User vault |
|-------|----------------|------------|
| Case create | `caseId`, `externalRef`, jurisdiction | — |
| Intake | `encryptedIntake` blob + `redactedScope` labels | Vault key never leaves browser |
| Discovery | Exposure URLs, match scores, redacted snippets | — |
| Approvals | Destination, data categories, purpose | User confirms each card |
| Execute | Status, broker id, `recorded` / `live` mode | Browser sends ephemeral handoff after approve |

Verify deployment trust anytime: `GET /v1/trust/attestation` (no auth required).

## Available presets (v1)

- `people-search-cleanup` — broker listing discovery + opt-out drafting
- `breach-exposure` — HIBP email check + password range (prefix-only)

More presets available on request. Live broker submission requires TEE attestation `pass` + explicit user approval.

## Phase 3: embeddable UI + onboarding

### Widgets (`@oblivion/partner-ui`)

```html
<link rel="stylesheet" href="/packages/partner-ui/widgets.css" />
<script type="module">
  import { OblivionApprovalPanel, OblivionStatusPanel, OblivionStatusBadge } from "/packages/partner-ui/widgets.js";
</script>
```

- `OblivionApprovalPanel` — renders pending disclosure cards; user must type confirmation
- `OblivionStatusPanel` — phase, pending approvals, recheck date
- `OblivionStatusBadge` — TEE/local runtime indicator

### Sandbox keys

```sh
OBLIVION_PARTNER_SANDBOX_KEYS=acme-sandbox:obl_sandbox_...
```

Sandbox partners get `environment: "sandbox"` in `GET /v1/partners/me`.

### Key rotation

```sh
POST /v1/partners/me/rotate-key
```

Returns new `apiKey` once. Previous key stops working immediately.

### Onboarding runbook

[Partner onboarding](/docs/developers/partner-onboarding) — 30-minute design-partner checklist.

## Phase 2: production-shaped integrations

### Webhook inbox (local dev)

Point webhooks at Oblivion's built-in inbox — no external server required:

```sh
curl -X POST http://localhost:8080/v1/webhooks/register-inbox \
  -H "Authorization: Bearer obl_live_your_secret_key"
```

Deliveries appear at `GET /v1/partners/me/webhook-inbox`. Signatures are verified with your webhook secret.

### Run until blocked

Advance the agent automatically until approvals are needed:

```sh
curl -X POST http://localhost:8080/v1/cases/$CASE_ID/run-until-blocked \
  -H "Authorization: Bearer ..." \
  -d '{"maxIterations":12}'
```

Returns `stoppedBecause`: `approval-required` | `blocked` | `complete` | `max-iterations`.

### Idempotent case create

`POST /v1/cases` with the same `externalRef` returns the existing active case (`200`, `idempotent: true`) instead of creating a duplicate.

### Partner SDK

```js
import { OblivionPartnerClient } from "@oblivion/partner-sdk";

const client = new OblivionPartnerClient({
  baseUrl: "http://localhost:8080",
  apiKey: "obl_live_your_secret_key"
});
await client.registerWebhookInbox();
const { case: c } = await client.createCase({ jurisdiction: "US", authorityBasis: "self", externalRef: "user_1" });
```

Live demo: [/examples/partner-demo/index.html](/examples/partner-demo/index.html) (when server is running).

## Core endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/cases` | Create partner-scoped case |
| `GET` | `/v1/cases` | List your cases (`?externalRef=` optional) |
| `POST` | `/v1/cases/:id/intake` | Encrypted intake (from user browser) |
| `POST` | `/v1/cases/:id/preset` | Start cleanup preset |
| `POST` | `/v1/cases/:id/discover` | Run exposure discovery |
| `POST` | `/v1/cases/:id/run` | Advance agent one step |
| `POST` | `/v1/cases/:id/run-until-blocked` | Advance until approval/blocked/complete |
| `DELETE` | `/v1/cases/:id` | Purge partner case |
| `POST` | `/v1/webhooks/register-inbox` | Use built-in webhook inbox (dev) |
| `GET` | `/v1/partners/me/webhook-inbox` | List received webhooks |
| `GET` | `/v1/trust/runtime` | Runtime mode badge (local/tee-verified) |
| `GET` | `/v1/cases/:id/status` | Phase, pending approvals, recheck |
| `GET` | `/v1/cases/:id/risk-summary` | Exposure counts (not a credit score) |
| `GET` | `/v1/cases/:id/approvals` | Pending + history |
| `POST` | `/v1/approvals/:id/approve` | User confirmation required |
| `POST` | `/v1/actions/:id/execute` | Execute after approve (handoff from browser) |
| `POST` | `/v1/webhooks` | Register webhook URL |
| `GET` | `/v1/partners/me/usage` | Metering summary |
| `GET` | `/v1/billing/balance` | Credit balance + rates |
| `GET` | `/v1/billing/invoices` | Closed invoices |
| `POST` | `/v1/billing/invoices/close` | Close period (`YYYY-MM`) |
| `GET` | `/v1/cases/:id/export` | Redacted export (audit logged) |
| `GET` | `/v1/partners/me/data-access` | Export/delete audit trail |
| `GET` | `/v1/webhooks/deliveries` | Delivery log (`?status=failed`) |
| `POST` | `/v1/webhooks/deliveries/:id/retry` | Retry one delivery |
| `POST` | `/v1/webhooks/deliveries/retry-failed` | Batch retry failed |
| `GET` | `/v1/trust/attestation` | TEE / compose verification |

Full OpenAPI sketch: [`openapi-v1.yaml`](openapi-v1.yaml).

## Phase 4: billing, retries, audit

### Invoices

Close a calendar month to generate a line-item invoice from metered usage:

```sh
curl -X POST https://api.oblivion.example/v1/billing/invoices/close \
  -H "Authorization: Bearer obl_live_..." \
  -d '{"period":"2026-06"}'
```

Returns `totalCredits`, `estimatedUsd` (from `OBLIVION_CREDITS_PER_USD`), and per-meter line items. Idempotent per period.

### Webhook retry dashboard

Failed deliveries store `attemptCount` and `nextRetryAt`. Retries use exponential backoff (`OBLIVION_WEBHOOK_RETRY_BASE_MS`, max `OBLIVION_WEBHOOK_MAX_RETRIES`).

```sh
GET /v1/webhooks/deliveries?status=failed
POST /v1/webhooks/deliveries/wh_.../retry
POST /v1/webhooks/deliveries/retry-failed
```

Due retries are also processed on `GET /v1/webhooks/deliveries`.

### Export/delete audit

Every partner export (`GET /v1/cases/:id/export` or authenticated `POST /api/export`) and delete (`DELETE /v1/cases/:id` or `POST /api/delete`) appends an immutable audit event. Query via `GET /v1/partners/me/data-access`. Partner export omits `userConfirmation` plaintext.

`case.deleted` webhook fires before purge.

### npm packages

```sh
npm install @oblivion/partner-sdk @oblivion/vault-sdk
```

Publish from monorepo root: `npm run publish:partner-packages` (requires npm org access).

## Webhooks

Signed with HMAC-SHA256: header `X-Oblivion-Signature` over `{timestamp}.{body}`.

Events: `case.created`, `case.phase_changed`, `exposure.discovered`, `approval.pending`, `approval.approved`, `action.executed`, `recheck.due`, `case.completed`, `case.deleted`.

## Billing

Partner credit pool (no wallet required):

| Meter | Default credits |
|-------|-----------------|
| Case create | 10 |
| Discovery run | 5 |
| Execute | 15 |
| AI (Venice) | 2 per 100 tokens (min 2) |

Configure via `OBLIVION_PARTNER_RATE_*` env vars. Ops refill: `POST /v1/admin/partners/:id/credits` with `X-Oblivion-Admin-Token` when `OBLIVION_PARTNER_ADMIN_TOKEN` is set.

## What partners must not do

- Decrypt `encryptedIntake` or store vault keys server-side
- Approve disclosures with only the partner API key
- Request bulk auto-approve or "trusted partner" bypass
- Send raw PII to your own LLM/analytics from Oblivion case data

## Support

- Consumer demo UI: same host, no API key
- Example app: `examples/partner-demo/`
- Vault SDK: `packages/vault-sdk/`

[Open Oblivion](https://oblivion.phantasy.bot)