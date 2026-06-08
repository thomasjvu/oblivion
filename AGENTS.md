# AGENTS.md

This file is the primary reference for AI coding agents and human maintainers working on Oblivion. Read it before proposing or making changes to core flows (case lifecycle, approvals, policy, redaction, attestation, client vault, connectors).

## Core Invariants (never break these)

- Browser vault is the only place raw sensitive identifiers live. Server stores only `encryptedIntake` (AES-256-GCM) + redacted metadata. See `src/crypto/clientVault.ts`, `src/api/app.ts:286` (intake), `src/domain/redaction.ts`.
- Every action that could disclose data goes through `proposeApprovedAction` (orchestration.ts:87) → policy `evaluateProposedAction` (policy.ts:54) → `Approval` record → explicit `userConfirmation` on `/approvals/:id/approve` → `canExecuteWithApproval` (policy.ts:100) before `execute`.
- `assertSensitiveExecutionAllowed` + runtimeGuard (runtimeGuard.ts:11) blocks `requiresManagedPlaintext` connectors (e.g. hibp-email) unless `verifierResult === "pass"`.
- No plaintext secrets in logs or responses: `sanitizeForLog` (safeLogging.ts:14) + `redactText`. All timelines, exports, connector results, venice inputs are redacted.
- Record-only is the default executor. Live connectors are stubs or gated. See `orchestration.ts:224`, `app.ts:347`.
- Attestation is not optional theater: `buildAttestationProof` (attestation.ts:33) checks pinned digests, compose hash, fresh Intel TDX quote via Phala, `verifierResult`.
- Presets and plans are the source of truth for workflow (cleanup.ts:33 CLEANUP_PRESETS, 170 advanceAgentPlan, 359 buildVisualNodes). Client may mirror for UX but server decides.
- `MemoryStore` + `OblivionRepository` (storage/) is the current persistence seam. All case data purge happens in `purgeCaseData` on delete.
- Hackathon/demo adapters (hackathon.ts) must stay behind the same policy/approval/redaction/attestation gates as real paths. They are not shortcuts.

## Project Layout (key files only)

- `src/server.ts` → `src/api/app.ts` (monolithic route handler, ~780 LOC, the "app" boundary)
- `src/api/http.ts` (readJson, send*, securityHeaders), `src/api/errors.ts`, `src/api/routes/connectors.ts`
- `src/domain/`: policy.ts, redaction.ts, safeLogging.ts, runtimeGuard.ts, attestation.ts, cleanup.ts (presets+plans), orchestration.ts (runCleanupAgentStep, propose, agent next), types.ts (the big union), hackathon.ts (x402, venice, a2a, 1shot), connectors.ts + sourceVerification.ts, templates.ts, deadlines.ts, status.ts
- `src/crypto/clientVault.ts` (browser + node compatible primitives; used by server for types, by public for impl)
- `src/storage/memoryStore.ts` (implements OblivionRepository; all the *ForCase helpers)
- `public/`: index.html, styles.css (per DESIGN.md), app.js (currently served raw; source now in public/src/ and bundled)
- `test/`: organized by layer — `domain/` (unit), `api/` (HTTP integration), `storage/`, `crypto/`, `orchestration/`, `ui/`, `deployment/`, `helpers/http.ts` (shared API fixtures), `e2e/` (Playwright), `smoke/`.
- `config/trust-center.json`, `Dockerfile`, `docker-compose.phala.yml`
- `DESIGN.md` (visual spec, colors, components), `SECURITY.md`, user-facing docs in `docs/src/docs/content/` (papers site)

No other frameworks. Pure node:http + Web Crypto + TS ESM.

## Running & Verification

- `npm run dev` → builds client then tsx src/server.ts (port 8080)
- `npm test` → tsx --test test/**/*.test.ts
- `npm run version:sync` → copies `package.json` version + git `sourceCommit` into `config/trust-center.json` (also runs at start of `verify` and `deploy:production`)
- `npm run typecheck`
- `npm run verify` → build:client + test + typecheck + design:lint (DESIGN.md only)
- `npm run e2e` → playwright (uses the running UI)
- `npm run design:lint`

Always run `npm run verify` before considering a change complete. Do not skip typecheck or tests for "obvious" edits.

## How the Agent Loop Works (for agents)

1. POST /api/cases (jurisdiction, authorityBasis, riskLevel) → CaseRecord with encryptedVaultPointer.
2. POST /api/cases/:id/intake with {encryptedIntake (client-encrypted), redactedScope}.
3. POST /api/cases/:id/preset {presetId, autonomyMode?} → creates AgentPlan, timeline events.
4. Agent advances via POST /api/cases/:id/agent/run or /api/agent/run-next.
   - Inside `runCleanupAgentStep` (orchestration.ts:111): builds proof, may switch to high-autonomy, then for currentStep does connector mocks, creates approvals via `createPresetApproval`, advances with `advanceAgentPlan`.
5. Approvals are proposed via /api/actions/propose (policy checked), approved with userConfirmation string (redacted on store), executed only if canExecute + status ready.
6. Sensitive connectors (connectors.ts) call `assertSensitiveExecutionAllowed` before any live call.
7. Everything that touches user text goes through redact or is stored only as ciphertext.

The UI agent dock + autopilot (public/src/main.js) is a convenience wrapper that calls the same endpoints and stops at approval gates.

## Adding Features Safely (checklist for AI + humans)

- New ActionType or PresetId? Add to types.ts, CLEANUP_PRESETS, templateForAction, policy if needed, create tests for the new path in evaluateProposedAction and advance.
- New connector? Register in CONNECTOR_REGISTRY (connectors.ts), add SourceVerificationRecord if it has an official URL, add test in connectors.test + source path, ensure it only runs after approval and (if requiresManagedPlaintext) after TEE pass.
- New AI / payment / relayer adapter? Put the demo logic in hackathon.ts or a new domain file. All inputs must be redacted before leaving the approval boundary. Add to /api/hackathon/status and timeline views. Never bypass propose/approve.
- Changing approval or execution? Update canExecuteWithApproval, policy, the approve + execute handlers, and the tests that assert "execution-blocked" and "approval-not-approved".
- Client change? Source lives in public/src/. Run build:client. Update any ui.test regexes that became too specific to old source layout. Prefer pushing computed titles / visualNodes / next prompts from the server responses instead of reimplementing in JS.
- Attestation / trust center? Changes must affect verifierResult, error collection, and the /trust/attestation + /trust/privacy responses. Update attestation.test.ts for new error cases.
- Logging? Every new log path must go through sanitizeForLog or redactText. Add or extend no-leak.test.ts.
- Never introduce a path that sends raw identifiers, full notes, or purpose containing PII in clear to the server without going through the encrypted intake blob + redaction on every other field.

## Known Test Gaps (high value to close)

From audit:
- Full policy decision matrix (all ActionTypes, dataToDisclose combos, sourceVerified false, plaintextPreview forbidden, every AuthorityBasis).
- Unit coverage for advanceAgentPlan every transition + blockedReasons + visualNodes (cleanup.ts).
- Direct units for runCleanupAgentStep, proposeApprovedAction, createPresetApproval (orchestration.ts).
- redaction.test.ts for redactIdentifier across all 14 categories + detectForbiddenSecrets edges.
- runtimeGuard.test.ts for all assertSensitive... branches + localSafe.
- Attestation error matrix (stale, compose mismatch, hardware false, intel-quote-not-found, replace- hashes, fetch failures).
- MemoryStore + status builder isolation tests.
- Stronger export/delete privacy assertions (never contains plaintext beyond the already-encrypted blob).
- Reduce brittle ui.test.ts bundle greps; prefer structure or add data-testid.

When adding tests, prefer pure domain units over more API integration where possible. Avoid global fetch mocks when you can use the in-memory store directly.

## Client (browser) Notes

- Currently one 1349 LOC file. We are moving to public/src/ + esbuild bundle (see package.json build:client). Bundle target is still public/app.js so serving, e2e, and ui.test (which reads the output) stay compatible.
- Global mutable `state` + imperative render() on every change + 20+ innerHTML= . Long term goal: smaller modules, event delegation, push more view model from server.
- Crypto in browser must match clientVault.ts semantics (AES-GCM, PBKDF2 310k, AAD usage). The extracted public/src/crypto.js is the single source for browser side.
- Recommendation heuristics and step title maps in client are UX sugar; server (orchestration + cleanup) is authoritative.
- Any new free-text field sent to /api/* (purpose, notes, etc.) must be treated as potentially sensitive. Prefer client-side redact before send for non-vault fields, or encrypt additional blobs.

## Docker / Phala / Prod

- Production image must be digest-pinned.
- TRUST_CENTER_PATH, PHALA_ATTESTATION_URL, OBLIVION_DISABLE_PLAINTEXT_LOGS=true, OBLIVION_EXECUTOR_MODE=record-only are required.
- Before enabling sensitive execution, GET /api/trust/attestation must return verifierResult: "pass" with composeHashMatches + imageDigestsPinned + hardwareQuoteVerified + attestationFresh.
- config/trust-center.json is a placeholder. Never commit real attestation report or secrets.

## Style & Process

- TypeScript strict, NodeNext, noEmit. Run typecheck.
- No new top-level comments in source unless the task explicitly asks for them.
- All changes must pass `npm run verify`.
- Update this file and README when invariants, major architecture, or "how to add X safely" changes.
- Prefer small PRs that touch one domain seam + its tests.
- For UI strings / copy, keep them in index.html or the JS render functions; DESIGN.md governs visual language.

## Partner API (B2B rail)

- Partner routes: `/v1/*` in `src/api/routes/v1.ts` (Bearer API key via `OBLIVION_PARTNER_KEYS`).
- Partner cases carry `partnerId` + `externalRef`; consumer `GET /api/cases` excludes them.
- Export/delete on partner cases require matching partner auth (`src/api/auth.ts`).
- Webhooks: `src/domain/webhooks.ts` — HMAC signed; dev inbox at `POST /v1/partners/:id/webhook-inbox`.
- Browser vault for partners: `packages/vault-sdk/`; HTTP client: `packages/partner-sdk/`.
- Docs site: `docs/` (papers + GBA theme) at https://oblivion-docs.phantasy.bot; app redirects `/help`, `/developers`, etc. via `OBLIVION_DOCS_URL`. Demo: `examples/partner-demo/`.
- UI widgets: `packages/partner-ui/` (`OblivionApprovalPanel`, `OblivionStatusPanel`).
- Sandbox keys: `OBLIVION_PARTNER_SANDBOX_KEYS`; rotation: `POST /v1/partners/me/rotate-key`.
- Webhooks: `recheck.due` on follow-up schedule, `case.completed` when plan reaches `complete`, `case.deleted` on purge.
- Billing: `partnerUsage` metering + `POST /v1/billing/invoices/close` for period invoices (`src/domain/partnerInvoices.ts`). Venice AI debits `ai` meter via `meterPartnerAiTokens` (orchestration, discovery, partner-case `/api/ai/*`).
- Consumer credits: wallet balance in `src/domain/credits.ts` + `X402_PRODUCTS` in `hackathon.ts` (`credit-starter` / `credit-monitor`). Distinct from partner pool in `partnerBilling.ts`.
- Webhook retries: `GET /v1/webhooks/deliveries`, `POST .../retry`, exponential backoff in `webhooks.ts`.
- Audit: `partnerDataAccess` log on export/delete (`partnerAudit.ts`); partner export strips `userConfirmation` plaintext.
- npm: `@oblivion/partner-sdk`, `@oblivion/vault-sdk` — `npm run publish:partner-packages`.
- **Never** add partner auto-approve or server-side vault decrypt — same invariants as consumer app.

## Quick References

- Policy entry: `evaluateProposedAction`, `canExecuteWithApproval`
- Plan machine: `createAgentPlan`, `advanceAgentPlan`, `buildAgentPlanView`, `WORKFLOW_STEPS`
- Redaction: `redactText`, `redactIdentifier`, `detectForbiddenSecrets`, `sanitizeForLog`
- Trust: `buildAttestationProof`, `assertSensitiveExecutionAllowed`
- Client vault: `encryptVaultPayload`, `wrapVaultKey`
- Store queries: all the `xxxForCase` methods on MemoryStore

If an edit would violate any invariant above, stop and surface the tension. The safety model is the product.

## Current Status (as of last audit)

- 120+ unit/integration tests; Playwright e2e in CI (desktop project).
- Typecheck clean; `npm run verify` is the merge gate.
- Client bundled from `public/src/` → `public/app.js`.
- Domain units added for policy, cleanup plan machine, orchestration propose, redaction, runtimeGuard, attestation errors, memoryStore isolation, broker web-form probe.
- Integration adapters require real API keys; `BROKER_WEBFORM_AUTOMATION` enables live web-form probing (not synthetic output).
- Production attestation requires synced `expectedComposeHash` in baked trust-center + `-prod-trust` redeploy.

Remaining gaps: full policy matrix for every ActionType/AuthorityBasis combo; every `advanceAgentPlan` transition; export/delete privacy matrix; reduce brittle ui.test greps.

Update this file when gaps are closed or new ones discovered.
