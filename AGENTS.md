# AGENTS.md

This file is the primary reference for AI coding agents and human maintainers working on Oblivion. Read it before proposing or making changes to core flows (case lifecycle, approvals, policy, redaction, attestation, client vault, connectors).

## Core Invariants (never break these)

- Browser vault is the only place raw sensitive identifiers live. Server stores only `encryptedIntake` (AES-256-GCM) + redacted metadata. See `src/crypto/clientVault.ts`, `src/api/handlers/caseHandlers.ts` (intake), `src/domain/redaction.ts`.
- Consumer `/api/*` case routes require a case access token (`Authorization: Bearer`) except `POST /api/cases`. Partner cases (`partnerId` set) must use `/v1/*` only. See `src/api/auth.ts`, `src/domain/caseAccess.ts`.
- Every action that could disclose data goes through `proposeApprovedAction` (`approvals.ts`) → policy `evaluateProposedAction` (`policy.ts`) → `Approval` record → explicit `userConfirmation` on approve → `canExecuteWithApproval` before `execute`.
- `assertSensitiveExecutionAllowed` + runtimeGuard blocks `requiresManagedPlaintext` connectors (e.g. hibp-email) unless `verifierResult === "pass"`.
- No plaintext secrets in logs or responses: `sanitizeForLog` + `redactText`. All timelines, exports, connector results, venice inputs are redacted.
- Record-only is the default executor in development; production profile enables live connectors (override with `OBLIVION_EXECUTOR_MODE`). See `deploymentEnv.ts`, `agentRunner.ts`, `executor.ts`.
- Attestation is not optional theater: `buildAttestationProof` checks pinned digests, compose hash, fresh Intel TDX quote via Phala, `verifierResult`.
- Presets and plans are the source of truth for workflow (`CLEANUP_PRESETS` metadata in `cleanup.ts`; `advanceAgentPlan`). Client may mirror for UX but server decides.
- `MemoryStore` + `OblivionRepository` (storage/) is the persistence seam. Default dev/prod profiles persist to `data/oblivion.json` via `createPersistentStore` (`src/storage/createStore.ts`); override with `OBLIVION_STORE_PATH`, `OBLIVION_STORE=sqlite` (snapshot in `data/oblivion.db` via `node:sqlite`), or `OBLIVION_STORE=memory` for ephemeral tests. Case-scoped maps use `CaseIndexedMap` / `CaseStoreMap` indexes (`src/storage/caseIndexedMap.ts`, `caseStoreMap.ts`). All case data purge happens in `purgeCaseData` on delete. Scheduler mutations (webhook retries, rechecks, delivery pruning) must call `store.markDirty()` and `scheduleStorePersist` in `app.ts`.
- Hackathon/demo adapters (`hackathon.ts`) stay behind the same policy/approval/redaction/attestation gates. `/api/hackathon/*` is gated by `HACKATHON_MODE=true`.

## Project Layout (key files only)

- `src/server.ts` → `src/api/app.ts` (thin dispatcher ~170 LOC)
- `src/api/routes/consumer.ts` — consumer `/api/*`
- `src/api/routes/v1.ts` — partner `/v1/*`
- `src/api/routes/connectors.ts`, `src/api/static.ts`
- `src/api/handlers/caseHandlers.ts`, `agentRun.ts`, `veniceMeter.ts`
- `src/api/http.ts`, `errors.ts`, `auth.ts`
- `src/domain/`: `policy.ts`, `policyMatrix.ts`, `exportPrivacy.ts`, `redaction.ts`, `attestation.ts`, `cleanup/` (presets, planAdvancement, pathBuilders), `status.ts`, `approvals.ts`, `agentRunner.ts`, `executor.ts`, `walletSession.ts`, `types/` (split types), `hackathon.ts`, `connectors.ts`, `caseAccess.ts`, `intakeScope.ts`
- `src/crypto/clientVault.ts`
- `src/storage/memoryStore.ts`
- `public/src/` → bundled `public/app.js` (`apiClient.js` manages case tokens)
- `test/`: `domain/`, `api/`, `helpers/http.ts`, `helpers/partner.ts`, `fixtures/`, `packages/`, `e2e/`
- `config/trust-center.json`, `Dockerfile`, `docker-compose.phala.yml`
- `DESIGN.md`, `SECURITY.md`, docs in `docs/src/docs/content/`

No other frameworks. Pure node:http + Web Crypto + TS ESM.

## Running & Verification

- Operator secrets: Infisical `secret-management` project syncs API keys + deploy URLs only (`scripts/lib/secrets-config.mjs` allowlists). Profile defaults live in `src/domain/deploymentEnv.ts`. `npm run secrets:pull:dev|prod` (see `SECURITY.md` § Infisical secret workflow).
- `npm run dev` → builds client then `tsx src/server.ts` (port 8080)
- `npm test` → tsx --test test/**/*.test.ts
- `npm run version:sync` → copies version + git `sourceCommit` into `config/trust-center.json`
- `npm run verify` → version:sync + build:client + build:vault-sdk + build:fonts + test + typecheck + design:lint
- `npm run e2e` → Playwright (case tokens in `test/e2e/caseAuth.ts`)
- `npm run docs:verify` → docs release checks

Always run `npm run verify` before considering a change complete.

## How the Agent Loop Works (for agents)

1. `POST /api/cases` → `{ case, accessToken }` (store token client-side).
2. `POST /api/cases/:id/intake` with Bearer token + `{encryptedIntake, redactedScope}`.
3. `POST /api/cases/:id/preset` → AgentPlan + timeline.
4. Agent advances via `POST /api/cases/:id/agent/run` (requires token).
   - `runCleanupAgentStep` in `agentRunner.ts`: preset registry drives discovery; approvals via `approvals.ts`; transitions via `advanceAgentPlan`.
5. Approvals: propose → approve (`userConfirmation`) → execute when `canExecuteWithApproval`.
6. Sensitive connectors call `assertSensitiveExecutionAllowed` before live calls.
7. User text goes through redact or encrypted intake only.

## Adding Features Safely (checklist)

- New ActionType or PresetId? Extend `CLEANUP_PRESETS` metadata + `types/agent.ts`; policy tests; preset registry test.
- New connector? `CONNECTOR_REGISTRY`, source verification, approval + TEE gates.
- New `/api` route? Add to `consumer.ts` or shared `caseHandlers.ts`; enforce `getCaseWithAccess` for consumer cases.
- New `/v1` route? Add to `v1.ts`; use shared handlers + `assertPartnerOwnsCase`.
- Client change? `public/src/`; `build:client`; prefer server-driven view models over client duplicates (`describeDiscoveryPlan`, `redactedScopeFromIntake`).
- Logging? `sanitizeForLog` / `redactText`; extend `no-leak.test.ts`.

## Partner API (B2B rail)

- `/v1/*` in `src/api/routes/v1.ts` (Bearer API key).
- Partner cases: `partnerId` + `externalRef`; blocked on `/api/*`.
- Shared handlers with consumer routes where logic overlaps.
- Never partner auto-approve or server-side vault decrypt.

## Quick References

- Auth: `requireCaseAccess`, `getCaseWithAccess`, `assertPartnerOwnsCase`, `assertCaseExportAllowed`
- Policy: `evaluateProposedAction`, `canExecuteWithApproval`
- Plan: `createAgentPlan`, `advanceAgentPlan`, `runCleanupAgentStep`
- Redaction: `redactText`, `redactIdentifier`, `sanitizeForLog`
- Trust: `buildAttestationProof`, `assertSensitiveExecutionAllowed`

## Current Status (as of pass-5 + deferred pass)

- 247+ unit/integration tests cover auth, policy, cleanup workflow, partner API, discovery/searchLabels, trust/purge/HIBP helpers, storage indexes/SQLite, webhook dedup/retention, and package SDKs; 5 Playwright E2E specs (desktop + mobile).
- `app.ts` thin dispatcher; `consumer.ts` and `v1.ts` dispatch to `routes/consumer/*` and `routes/v1/*`; `integrations/` split under consumer.
- Shared handlers: `caseHandlers.ts`, `caseLifecycle.ts`, `agentRun.ts`; payments in `domain/payments/`; timeline in `agentTimeline.ts`; `hackathon.ts` is hackathon-only (no re-export hub).
- HIBP logic unified in `domain/connectors/hibp.ts`; trust privacy in `domain/trustPrivacy.ts`; credit settlement in `domain/payments/settlement.ts`.
- Case access token auth on consumer API; partner isolation enforced; v1 approve/execute checks ownership before handlers.
- Types split under `src/domain/types/` with barrel re-export from `types.ts`.
- Client: `public/app.js` + chunks gitignored; flow modules (`casesFlow`, `walletFlow`, `paymentsFlow`, `agentFlow`, `intakeFlow`, `discoveryUi`, `guideFlow`, `panelRenderers`); `renderScheduler.js` scoped invalidation; x402 lazy via `x402Gate.js`.

Remaining gaps: none documented — policy matrix (`policyMatrix.ts`) and export/delete privacy matrix (`exportPrivacy.ts`) are source of truth with tests.

Update this file when gaps close or invariants change.