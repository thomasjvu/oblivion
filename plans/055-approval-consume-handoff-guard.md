# Plan 055: Don't burn approval on handoff / blocked execute

## Status: DONE

## Problem

`executeApprovedActionFlow` always set `approval.status = "used"` after execute, even when the connector required user handoff or live execution returned no `connectorResult`. Users could not re-execute after completing a handoff. Handoff paths incorrectly returned `executionStatus: "executed"`.

## Solution

- `shouldConsumeApprovalAfterExecute()` — skips consume when `requiresUserHandoff` or live mode lacks `connectorResult`.
- `resolveExecutionStatusAfterExecute()` — returns `"ready"` for handoff (not `"executed"`).
- Unverified connector source now throws `DomainError("connector-source-unverified", 503)` instead of silent blocked return.

## Files

- `src/domain/executor.ts`
- `test/domain/executor-approval-consume.test.ts`

## Verify

`npm test -- test/domain/executor-approval-consume.test.ts`