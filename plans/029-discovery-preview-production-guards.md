# Plan 029: Enforce production discovery preview quota and redacted sweep queries

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/discoveryPreview.ts src/domain/deploymentEnv.ts test/api/discoveryPreview.test.ts docker-compose.phala.yml`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`POST /api/discovery/preview` is public and drives Brave/Venice broker sweeps. When `OBLIVION_PREVIEW_DAILY_LIMIT` is `0` (default and Phala compose), `assertPreviewQuota` is a no-op — unlimited operator API usage. Separately, sweep queries can embed raw `personLabel` from the client instead of redacted labels, sending full names to third-party search APIs.

## Current state

- `src/domain/discoveryPreview.ts:25-33` — `previewDailyLimit()` returns `0` when env unset; `previewQuotaEnabled()` false.
- `src/domain/discoveryPreview.ts:60-67` — `assertPreviewQuota` returns immediately when quota disabled.
- `src/domain/discoveryPreview.ts:145-163` — sweep uses raw `input.personLabel.trim()` for broker queries.
- `test/api/discoveryPreview.test.ts` — tests unlimited-by-default behavior.
- `src/domain/deploymentEnv.ts` — production profile detection (`assertProductionSafety`).

Convention: use `DomainError` with codes like `preview-quota-exceeded` (429).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/api/discoveryPreview.test.ts test/domain/discoveryPreview.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/discoveryPreview.ts`
- `src/domain/deploymentEnv.ts` (if production default helper needed)
- `test/api/discoveryPreview.test.ts`
- `docker-compose.phala.yml` (set non-zero preview limit for prod compose)
- `test/deployment/deployment.test.ts` (if compose assertion needed)

**Out of scope**:
- Wallet-authenticated preview (future)
- Full IP rate limiting at edge (CDN)

## Steps

### Step 1: Production-safe default limit

When `OBLIVION_PREVIEW_DAILY_LIMIT` is unset or `0`:
- In production profile (`deploymentEnv` production detection), use default limit of **5** per day per IP/wallet.
- In dev/test, keep `0` = unlimited unless `OBLIVION_PREVIEW_DAILY_LIMIT` explicitly set.

Document env in comment near `previewDailyLimit()`.

**Verify**: unit test for `previewDailyLimit()` under mocked `OBLIVION_DEPLOYMENT_ENV=production`

### Step 2: Redact sweep query inputs

Build broker sweep scope from `redactText(input.personLabel)` (and redacted aliases). Reject labels matching `detectForbiddenSecrets` or obvious email patterns before outbound fetch.

Add test asserting query string passed to mocked fetch does not contain raw email-like input.

**Verify**: `npm test -- test/domain/discoveryPreview.test.ts` → pass

### Step 3: Update API tests

Change `discovery preview is public, unlimited by default` to:
- unlimited in dev default store
- limited when production env + limit applied

**Verify**: `npm test -- test/api/discoveryPreview.test.ts` → pass

### Step 4: Align Phala compose

Set `OBLIVION_PREVIEW_DAILY_LIMIT=5` (or similar) in `docker-compose.phala.yml` if still `0`.

**Verify**: `npm test -- test/deployment/deployment.test.ts` → pass

## Done criteria

- [ ] Production default limits preview; dev remains unlimited without env
- [ ] Sweep queries use redacted labels
- [ ] `npm run verify` exits 0
- [ ] `plans/README.md` row 029 → DONE

## STOP conditions

- Production profile detection API changed from `deploymentEnv.ts` excerpts.
- Redacting labels breaks all preview matches and product requires raw names (report back).

## Maintenance notes

If onboarding UX needs more free previews, tune default limit via Infisical — not by disabling quota in production.