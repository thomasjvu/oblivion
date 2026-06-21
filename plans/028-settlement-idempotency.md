# Plan 028: Make credit settlement idempotent per payment session

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/payments/settlement.ts src/domain/credits.ts test/domain/payments-settlement.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

A holder of a case access token can call `/api/credits/purchase` or `/api/credits/monitor` multiple times with the same verified `paymentSessionId`. Each call runs `settleCreditsForProduct` again because `settleCreditProduct` never checks whether the session is already `paid`. That can double-credit wallets for a single on-chain payment.

## Current state

- `src/domain/payments/settlement.ts:15-48` — `settleCreditProduct` always calls `markSessionPaid` then `settleCreditsForProduct` when session matches; no `session.status === "paid"` short-circuit.
- `src/domain/credits.ts` — `settleCreditsForProduct` appends ledger credits without idempotency key.
- `test/domain/payments-settlement.test.ts` — tests reject unpaid and accept paid once; no replay test.

Error handling uses `DomainError` in domain layer; API maps via `toHttpError` in `src/api/errors.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test -- test/domain/payments-settlement.test.ts` | all pass |
| Full gate | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/payments/settlement.ts`
- `src/domain/credits.ts` (only if ledger idempotency helper needed)
- `test/domain/payments-settlement.test.ts`

**Out of scope**:
- x402 verification logic (`src/domain/x402.ts`)
- Partner billing meters
- OpenAPI changes

## Git workflow

- Branch: `advisor/028-settlement-idempotency`
- Commit style: match repo (`Harden security...`, `fix(domain): ...`)

## Steps

### Step 1: Short-circuit already-paid sessions

In `settleCreditProduct`, after session validation (lines 31-44), if `session.status === "paid"`:
- Return the same shape as a successful settlement (credits view + session) without calling `settleCreditsForProduct` again.
- Use `resolveCreditsView` for the response payload.

**Verify**: `npm test -- test/domain/payments-settlement.test.ts` → pass

### Step 2: Add replay regression test

Add test `settleCreditProduct is idempotent when session already paid`:
- Seed case + session, mark paid once with settlement tx.
- Call `settleCreditProduct` again with same session id and tx.
- Assert credit balance unchanged (or ledger entry count unchanged).

Model after existing tests in `test/domain/payments-settlement.test.ts`.

**Verify**: `npm test -- test/domain/payments-settlement.test.ts` → 3+ tests pass

### Step 3: Optional ledger guard

If `settleCreditsForProduct` can still be called from other paths, add optional `paymentSessionId` metadata on ledger entries and skip duplicate credit for same session id.

Only do this if step 1 alone leaves another call path that can double-credit.

**Verify**: `npm run verify` → exit 0

## Test plan

- Replay paid session → no additional credits.
- First settlement still works (existing tests green).

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] New idempotency test exists and passes
- [ ] `plans/README.md` row 028 → DONE

## STOP conditions

- Session model has no `status` field or paid semantics differ from excerpts.
- Idempotency fix requires changing public API response shape for first settlement.

## Maintenance notes

Any new settlement entry point must call `settleCreditProduct` only; do not call `settleCreditsForProduct` directly from routes.