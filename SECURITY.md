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
- Keep secrets in Phala encrypted secrets, not Docker Compose plaintext.
- Disable plaintext logs and request tracing.
- Add external adapters only after tests prove blocked execution without matching approval.

## Production Runbook

1. **Build and pin** — `npm run docker:build:remote` (or local build), then `npm run docker:pin -- ghcr.io/thomasjvu/oblivion@sha256:<digest>`.
2. **Deploy CVM** — `npm run phala:deploy` with secrets via `scripts/deploy-phala.sh -e .env` (never commit `.env`).
3. **Sync trust** — `npm run phala:sync-trust` copies the live compose hash into `config/trust-center.json` and updates `sourceCommit`.
4. **Rebuild trust image** — bake the synced `config/trust-center.json` into a `-prod-trust` image and redeploy so the CVM serves matching metadata.
5. **Verify attestation** — `curl -s $API/api/trust/attestation | jq '.verifierResult, .composeHashMatches, .hardwareQuoteVerified'` must show `pass`, `true`, `true`.
6. **Check integrations** — `GET /api/integrations/status` lists `liveReady.*` for configured adapters only.
7. **Enable live executor (optional)** — set `OBLIVION_EXECUTOR_MODE=live` in Phala secrets after attestation passes. Managed-plaintext connectors (HIBP email, broker live paths) still require `verifierResult: "pass"`.
8. **Never enable `OBLIVION_AI_BYPASS_PAYMENT` in production** — Venice chat/analysis requires a paid x402 session per case.

### Live integration secrets checklist

| Secret | Enables |
|--------|---------|
| `BRAVE_SEARCH_API_KEY` | Exposure URL discovery |
| `VENICE_API_KEY` | Agent classify/draft/review/chat |
| `X402_PAY_TO` + `X402_FACILITATOR_URL` | Real x402 settlement |
| `ONESHOT_API_KEY` | Live 1Shot JSON-RPC relay |
| `HIBP_API_KEY` | Live breach email check (TEE-gated) |
| `RESEND_API_KEY` or `SMTP_*` | Broker/platform email connectors |
| `OBLIVION_EXECUTOR_MODE=live` | External connector execution after approval |

## User-Facing Claim

Use precise wording:

> Oblivion cannot read your stored case vault. Sensitive data is encrypted in your browser before storage. For approved actions that require plaintext, data is decrypted only in your browser or inside an attested TEE task for that specific action.

Avoid absolute wording such as "we never touch data" because approved third-party submissions still disclose the user's approved identifiers to brokers, controllers, search engines, or breach-check services.

## Partner API (B2B)

Embedded partners (password managers, VPNs, security suites) integrate via `/v1/*` with Bearer API keys. Partner servers must **not** decrypt `encryptedIntake` or approve disclosures on behalf of users.

- Partner cases carry `partnerId` + `externalRef`; list/export/delete require matching API key.
- Partners receive redacted scope, exposure URLs, approval metadata, and signed webhooks.
- Plaintext transits only from the **user browser** in an approved execute handoff.
- No "trusted partner" auto-approve bypass — same policy gates as the consumer app.

See the [Partner API](https://oblivion-docs.phantasy.bot/docs/developers/partner-api).
