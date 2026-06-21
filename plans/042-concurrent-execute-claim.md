# Plan 042: Atomically claim action before execute (close TOCTOU race)

> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/domain/executor.ts test/domain/executor.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/030-atomic-action-execute.md (DONE)
- **Category**: correctness
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

Plan 030 sets `executionStatus = "executing"` only after several checks. Two concurrent execute requests can both observe `ready` in the synchronous window before either sets `executing`, allowing duplicate live connector runs in production.

## Current state

```50:67:src/domain/executor.ts
  if (input.action.executionStatus === "executing") { ... }
  if (input.action.executionStatus === "executed" || input.action.executionStatus === "recorded") { ... }
  const decision = canExecuteWithApproval(input.approval);
  // ...
  input.action.executionStatus = "executing";
```

No concurrent regression test in `test/domain/executor.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/executor.test.ts test/api/app.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/executor.ts`
- `test/domain/executor.test.ts`

**Out of scope**:
- Multi-instance distributed locks

## Steps

### Step 1: Claim before policy checks

Reorder `executeApprovedActionFlow`:
1. If `executionStatus !== "ready"`, throw appropriate 409 (executing/executed/recorded/blocked/failed).
2. Set `executionStatus = "executing"` immediately (synchronous claim).
3. Run `canExecuteWithApproval`; on deny, revert to `ready` and throw 403.

Keep `approval.status === "used"` check before claim.

**Verify**: existing executor tests pass

### Step 2: Concurrent test

Add test spawning two parallel `executeApprovedActionFlow` calls on same action/approval (record-only mode):
- Exactly one succeeds
- Other rejects with `action-already-executing` or `action-already-executed`

Use `Promise.allSettled`.

**Verify**: `npm test -- test/domain/executor.test.ts` → pass

### Step 3: API regression

Ensure `test/api/app.test.ts` lifecycle execute still passes.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Concurrent test proves single success
- [ ] `plans/README.md` row 042 → DONE

## STOP conditions

- Claim-before-policy breaks legitimate retry after 403 — document and adjust revert logic.

## Maintenance notes

Partner `/v1/actions/:id/execute` uses same `executeApprovedActionFlow` — no separate fix needed.