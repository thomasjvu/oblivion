# Plan 015: Recheck follow-up automation (design spike)

## Status: PARTIAL — route, scheduler, and webhooks shipped; discovery loop open (plan 032)

## Shipped (commit 10d15ae)

- `POST /v1/cases/:id/recheck` (`src/api/routes/v1/cases.ts`)
- `processDueRechecks` on maintenance scheduler (`src/api/app.ts`)
- `FollowUp.status` + `triggerRecheckForFollowUp` (`src/domain/recheck.ts`)

## Remaining

Follow-ups are scheduled (`pathBuilders.ts`, `agentRunner.ts`) and `recheckOverdue` is computed (`partnerStatus.ts`), but recheck does not yet re-run discovery when `dueDate` passes — see plan 032.

## Proposed direction

1. Add `POST /v1/cases/:id/recheck` (partner) and optional consumer equivalent behind activation + credits.
2. Internal scanner: on agent run or scheduled tick, find `followUps` where `dueDate <= now` and `status === "pending"`.
3. Emit `recheck.due` webhook at due time (not only at schedule time).
4. Idempotency key per follow-up + case to prevent duplicate live sweeps.

## Open questions

- Credit metering for automated re-discovery?
- Phala CVM restart safety for in-process timers vs external cron?
- Partner webhook semantics: `scheduled` vs `overdue` vs `completed`?

## Depends on

File-backed persistence documented (018). Durable job queue (024) if multi-instance.