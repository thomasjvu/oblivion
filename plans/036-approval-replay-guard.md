# Plan 036: Reject re-approve on consumed approvals

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/api/handlers/caseHandlers.ts src/domain/approvals.ts test/api/app.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/030-atomic-action-execute.md (complementary; can land in either order)
- **Category**: correctness
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`handleApprove` never checks `approval.status`. After execute sets `approval.status = "used"`, a second `POST …/approve` resets status to `approved` and linked actions to `executionStatus = "ready"`, allowing another execute for the same user confirmation. Plan 030 fixes concurrent double-execute but not this sequential replay.

## Current state

```164:178:src/api/handlers/caseHandlers.ts
export async function handleApprove(store: MemoryStore, approvalId: string, body: ApproveBody) {
  const approval = store.approvals.get(approvalId);
  // checks expiry and userConfirmation only
  approval.status = "approved";
  // ...
  for (const action of store.actions.values()) {
    if (action.approvalId === approval.id) action.executionStatus = "ready";
  }
}
```

- `src/domain/executor.ts:70` — sets `approval.status = "used"` after execute.
- `src/domain/policy.ts:89-97` — `canExecuteWithApproval` requires `status === "approved"`.

Partner approve handler may mirror this — grep `handleApprove` / `approve` in `src/api/routes/v1/`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/api/app.test.ts test/api/partner-lifecycle.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/api/handlers/caseHandlers.ts` — `handleApprove`
- Partner approve route if it duplicates logic (refactor to shared guard if trivial)
- `src/domain/approvals.ts` — optional `assertApprovalApprovable(approval)` helper
- Tests: approve → execute → approve → must fail

**Out of scope**:
- New approval creation flows
- HIBP connector routes (plan 038)

## Steps

### Step 1: Add status guard

Before mutating approval in `handleApprove`, require `approval.status === "pending"`. If `used`, `rejected`, or already `approved` with executed action, return 409 `approval-not-pending` (or reuse existing error codes from `src/api/errors.ts`).

Also reject when linked action has `executionStatus` in `executed`, `recorded`, or `failed` if that is simpler than status alone.

**Verify**: `npm test -- test/api/app.test.ts` → pass

### Step 2: Scope action scan to case

While touching approve handler, replace `store.actions.values()` with `store.actionsForCase(approval.caseId)` (perf fix, same PR).

**Verify**: existing approve tests green

### Step 3: Partner route parity

Check `src/api/routes/v1/cases.ts` or partner handlers for duplicate approve logic; apply same guard.

**Verify**: `npm test -- test/api/partner-lifecycle.test.ts` → pass

### Step 4: Replay regression test

Add API test:
1. Create case, propose + approve action
2. Execute (record-only mode is fine)
3. Second approve on same approvalId → 409

**Verify**: `npm run verify` → exit 0

## Test plan

- Happy path approve unchanged
- Used approval cannot be re-approved

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Replay test exists
- [ ] `plans/README.md` row 036 → DONE

## STOP conditions

- Product requires explicit "re-open" approval UX — STOP and report instead of hard 409.
- Approval status enum differs from `pending` / `approved` / `used`.

## Maintenance notes

Any new approve entry point must call the shared guard. Works with plan 030's in-flight claim for full execute idempotency.