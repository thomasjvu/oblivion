# Plan 032: Wire recheck to scoped re-discovery

> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/recheck.ts src/domain/exposureDiscovery.ts src/api/routes/v1/cases.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (benefits from 030 if recheck triggers execute-like side effects)
- **Category**: direction
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`POST /v1/cases/:id/recheck` marks follow-ups `triggered` and emits `recheck.due` webhooks but does not re-run discovery. The spike goal in `plans/015-recheck-automation-spike.md` — re-scan when `dueDate` passes — remains open. Partners must manually call `/discover` after every recheck webhook.

## Current state

- `src/domain/recheck.ts:19-46` — webhook + timeline only.
- `src/api/handlers/caseHandlers.ts:99+` — `handleCaseDiscover` runs `discoverExposureCandidates`.
- `src/domain/partnerBilling.ts:10` — `recheck` meter rate exists.
- `test/api/partner-recheck.test.ts` — asserts `triggered` status only.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/recheck.test.ts test/api/partner-recheck.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/recheck.ts`
- `src/domain/exposureDiscovery.ts` (optional scoped discover helper)
- `src/api/routes/v1/cases.ts` (if metering changes)
- `test/domain/recheck.test.ts`, `test/api/partner-recheck.test.ts`
- Update `plans/015-recheck-automation-spike.md` status to PARTIAL with checklist

**Out of scope**:
- Consumer `/api/cases/:id/recheck` (separate plan)
- Credit model changes beyond existing partner `recheck` meter

## Steps

### Step 1: Scoped discover helper

Add `discoverForRecheck(store, caseRecord, followUp)` that:
- Loads case redacted scope / preset
- If `followUp.brokerId`, limits sweep to that broker host
- If `followUp.exposureId`, optionally re-probes that URL
- Calls existing discovery primitives; does not decrypt intake

**Verify**: unit test with mocked `fetch` shows discover invoked

### Step 2: Invoke from triggerRecheckForFollowUp

After marking `triggered`, call scoped discover.
Emit `exposure.discovered` webhooks for new findings (reuse `emitCaseWebhook` pattern from `caseHandlers`).

**Verify**: `test/domain/recheck.test.ts` updated

### Step 3: API test proves discovery side effect

Extend `test/api/partner-recheck.test.ts` to seed exposure + mock discover path; assert new exposure or timeline entry beyond `triggered`.

**Verify**: `npm run verify` → exit 0

### Step 4: Update spike doc

Mark `plans/015-recheck-automation-spike.md` as PARTIAL — route/scheduler done; discovery loop done after this plan.

## Done criteria

- [ ] Recheck triggers scoped discovery, not webhook-only
- [ ] Idempotent: re-triggering same follow-up does not re-run (status `triggered`)
- [ ] `npm run verify` exits 0
- [ ] `plans/README.md` row 032 → DONE

## STOP conditions

- Scoped discover requires plaintext intake server-side (violates vault invariant — STOP).
- Discovery always requires wallet credits not available on partner meter path.

## Maintenance notes

Meter as `recheck` or `discover` consistently; document in partner-api.md when DOCS plan lands.