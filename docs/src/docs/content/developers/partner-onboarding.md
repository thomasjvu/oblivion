# Design Partner Onboarding Runbook

30-minute path from zero to a working people-search cleanup integration.

## Prerequisites

- Oblivion API running (local or Phala CVM)
- HTTPS callback URL for production webhooks (inbox URL works for local dev)
- Your app can host a browser WebView or page for vault intake + approvals

## Step 1 — Get credentials (5 min)

```sh
# Production partner
OBLIVION_PARTNER_KEYS=yourco:obl_live_...

# Sandbox (lower credits, same API)
OBLIVION_PARTNER_SANDBOX_KEYS=yourco-sandbox:obl_sandbox_...
```

Verify:

```sh
curl -s http://localhost:8080/v1/partners/me \
  -H "Authorization: Bearer obl_live_..."
```

## Step 2 — Register webhooks (5 min)

**Local dev** (no external server):

```sh
curl -X POST http://localhost:8080/v1/webhooks/register-inbox \
  -H "Authorization: Bearer ..."
```

**Production**:

```sh
curl -X POST https://api.oblivion.example/v1/webhooks \
  -H "Authorization: Bearer ..." \
  -d '{"url":"https://yourco.com/webhooks/oblivion","secret":"whsec_..."}'
```

Verify signatures with `@oblivion/partner-sdk/webhooks` → `verifyOblivionWebhook`.

Events you will receive: `case.created`, `exposure.discovered`, `approval.pending`, `approval.approved`, `action.executed`, `recheck.due`, `case.completed`.

## Step 3 — Integrate SDK (10 min)

```html
<link rel="stylesheet" href="/packages/partner-ui/widgets.css" />
<script type="module">
  import { OblivionPartnerClient } from "/packages/partner-sdk/index.js";
  import { OblivionApprovalPanel, OblivionStatusPanel } from "/packages/partner-ui/widgets.js";
  import { createVaultKey, encryptVaultPayload } from "/packages/vault-sdk/dist/index.js";
  import { buildEncryptedIntake } from "/packages/vault-sdk/helpers.js";

  const client = new OblivionPartnerClient({ baseUrl: "...", apiKey: "..." });

  // Backend: create case
  const { case: c } = await client.createCase({
    jurisdiction: "US",
    authorityBasis: "self",
    externalRef: "user_12345"
  });

  // Browser: encrypt intake (never from your server)
  const vaultKey = await createVaultKey();
  const intake = await buildEncryptedIntake(vaultKey, c.id, { contactEmail: "...", notes: "..." }, encryptVaultPayload);
  await client.submitIntake(c.id, intake);

  await client.applyPreset(c.id, "people-search-cleanup");
  await client.runUntilBlocked(c.id);

  const approvals = new OblivionApprovalPanel({
    client, caseId: c.id, container: "#approvals", contactEmail: "user@example.com"
  });
  await approvals.refresh();
</script>
```

Live reference: [/examples/partner-demo/index.html](/examples/partner-demo/index.html)

## Step 4 — Demo checklist (10 min)

| Step | API | Partner server sees |
|------|-----|---------------------|
| Create case | `POST /v1/cases` | `caseId`, `externalRef` |
| User intake | `POST /v1/cases/:id/intake` | ciphertext + redacted labels only |
| Start preset | `POST /v1/cases/:id/preset` | webhook `case.phase_changed` |
| Discover | `POST /v1/cases/:id/discover` | exposure URLs (redacted snippets) |
| User confirms | `POST .../exposures/:id/confirm` | — |
| Agent runs | `POST .../run-until-blocked` | webhook `approval.pending` |
| User approves | `POST /v1/approvals/:id/approve` | webhook `approval.approved` |
| Execute | `POST /v1/actions/:id/execute` | webhook `action.executed` (record-only) |

## Security checklist

- [ ] Vault key never sent to partner backend
- [ ] Partner API key stored in secrets manager, not client bundle
- [ ] Approval UI requires end-user typed confirmation
- [ ] Webhook signatures verified before acting on events
- [ ] `GET /v1/trust/runtime` shows expected mode before offering live execution

## Phase 4: billing + npm SDKs

```sh
npm install @oblivion/partner-sdk @oblivion/vault-sdk
```

Close monthly usage for invoicing:

```sh
curl -X POST http://localhost:8080/v1/billing/invoices/close \
  -H "Authorization: Bearer ..." \
  -d '{"period":"2026-06"}'
```

Monitor failed webhooks: `GET /v1/webhooks/deliveries?status=failed`

## Key rotation

```sh
curl -X POST http://localhost:8080/v1/partners/me/rotate-key \
  -H "Authorization: Bearer ..."
```

Response includes new `apiKey` once. Update your secrets immediately.

## Support contacts

- API docs: [`PARTNER_API.md`](PARTNER_API.md)
- OpenAPI: [`openapi-v1.yaml`](openapi-v1.yaml)
- Maintainer guide: [`AGENTS.md`](../AGENTS.md)

[Open Oblivion](https://oblivion.phantasy.bot)