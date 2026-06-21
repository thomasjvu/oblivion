# Plan 030: Claim approval before async action execute (prevent double execution)

> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/executor.ts src/domain/approvals.ts src/api/handlers/caseHandlers.ts test/domain/executor.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`executeApprovedActionFlow` checks `canExecuteWithApproval`, then awaits `executeApprovedAction` (which may call live connectors), and only then sets `approval.status = "used"`. Two concurrent execute requests can both pass while status is still `approved`, causing duplicate live connector runs in production.

## Current state

```50:71:src/domain/executor.ts
export async function executeApprovedActionFlow(input: ExecuteApprovedActionFlowInput): Promise<ExecuteActionResult> {
  const decision = canExecuteWithApproval(input.approval);
  // ...
  const executed = await executeApprovedAction({ ... });
  input.action.executionStatus = resolveExecutionStatusAfterExecute(executed);
  input.action.executedAt = new Date().toISOString();
  input.action.executionRecord = executed.executionRecord;
  input.approval.status = "used";
  return executed;
}
```

- `src/api/handlers/caseHandlers.ts` — `handleExecute` calls `executeApprovedActionFlow` without checking `action.executionStatus` first.
- Approval statuses in `src/domain/types/` — `approved`, `used`, etc.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/executor.test.ts test/api/app.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/executor.ts`
- `src/domain/approvals.ts` (if claim helper belongs here)
- `test/domain/executor.test.ts`
- `test/api/app.test.ts` (lifecycle execute test)

**Out of scope**:
- Distributed locks across multiple server instances (document single-writer assumption)
- Changing approval expiry rules

## Steps

### Step 1: Synchronous execution claim

Before any `await` in `executeApprovedActionFlow`:
- If `input.approval.status !== "approved"`, throw `DomainError("approval-not-executable", 409)`.
- If `input.action.executionStatus` is `executed` or `recorded`, throw `DomainError("action-already-executed", 409)`.
- Set `input.approval.status = "executing"` synchronously (add to Approval status union if needed, or use action `executionStatus = "executing"`).

On execute failure after claim, set approval back to `approved` and action to `ready` or `failed` as appropriate.

**Verify**: `npm test -- test/domain/executor.test.ts` → pass

### Step 2: Second execute rejected

Add test: after successful execute, second `executeApprovedActionFlow` throws 409.

Add test: simulate in-flight by setting `executing` and assert concurrent call fails.

**Verify**: tests pass

### Step 3: API lifecycle regression

Ensure `test/api/app.test.ts` case lifecycle still passes.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Duplicate execute returns 409, not double connector run
- [ ] `npm run verify` exits 0
- [ ] `plans/README.md` row 030 → DONE

## STOP conditions

- Approval status union cannot extend without breaking persisted JSON cases.
- Live executor tests require TEE mock changes beyond plan scope.

## Maintenance notes

Reviewers should verify any new execute entry point uses `executeApprovedActionFlow`, not raw `executeApprovedAction`.