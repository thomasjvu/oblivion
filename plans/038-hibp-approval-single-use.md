# Plan 038: Consume HIBP connector approvals on successful use

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/api/routes/connectors.ts src/domain/executor.ts test/api/connectors.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (complements plan 036)
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`POST /api/connectors/hibp/email-check` calls `canExecuteWithApproval` but never marks the approval `used`. One approval allows unlimited email checks with different `emailLabel` values, disclosing arbitrary emails to HIBP under a single user confirmation card.

## Current state

```69:88:src/api/routes/connectors.ts
if (method === "POST" && url.pathname === "/api/connectors/hibp/email-check") {
  // ...
  const decision = canExecuteWithApproval(approval);
  if (!decision.allowed) throw new HttpError(403, "execution-blocked", ...);
  // fetchHibpEmailBreach(email) — no approval.status = "used"
}
```

Password-range route (`/api/connectors/hibp/password-range`) has the same pattern — decide policy: one-shot per approval for both, or allow multiple prefix lookups per range approval (document choice in tests).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/api/connectors.test.ts test/domain/hibp.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/api/routes/connectors.ts` — email-check (required); password-range (if one-shot policy)
- Tests for second call with same approval → 403

**Out of scope**:
- `executeApprovedActionFlow` refactor
- Policy matrix changes unless needed for password-range semantics

## Steps

### Step 1: Mark approval used after successful email check

After `fetchHibpEmailBreach` succeeds and before response, set `approval.status = "used"` and `approval.updatedAt` if field exists. Persist via store map update.

**Verify**: `npm test -- test/api/connectors.test.ts` → pass

### Step 2: Reject used approvals

`canExecuteWithApproval` already fails when status !== `approved`. After step 1, second call returns 403 — add explicit test.

**Verify**: new test `hibp email-check cannot reuse approval` passes

### Step 3: Password-range policy

If product intent is one prefix per approval: same `used` marking. If multiple prefixes per approval is intentional, add test documenting allowed reuse and only consume on email-check.

Check `src/domain/policyMatrix.ts` for `hibp-email-check` / `pwned-password-range-check` entries.

**Verify**: policy tests still pass

### Step 4: No-leak check

Ensure error responses do not include raw email labels — existing redaction should hold; run `npm test -- test/domain/no-leak.test.ts` if connector tests touch logs.

**Verify**: `npm run verify` → exit 0

## Test plan

- First email-check with valid approval → 200
- Second email-check same approvalId → 403

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Single-use test for email-check
- [ ] `plans/README.md` row 038 → DONE

## STOP conditions

- Policy matrix explicitly allows unlimited email checks per approval — update matrix + docs instead of consuming.
- Approval model has no `used` status in types.

## Maintenance notes

New direct connector routes that bypass `executeApprovedActionFlow` must consume approvals explicitly or delegate to shared execute helper.