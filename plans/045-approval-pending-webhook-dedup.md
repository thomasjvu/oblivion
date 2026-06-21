# Plan 045: Dedup approval.pending webhooks

## Status: DONE

## Problem

`notifyCasePendingApprovals` re-emitted `approval.pending` for every pending approval on each agent step, flooding partners.

## Solution

- `Approval.pendingWebhookEmittedAt` tracks first emission.
- `emitApprovalPendingWebhook` skips when already set; `notifyCasePendingApprovals` routes through it.

## Verify

`npm test -- test/domain/approval-pending-webhook.test.ts`