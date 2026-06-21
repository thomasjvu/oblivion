# Plan 046: Webhook delivery retention (PERF-01)

## Status: DONE

## Problem

`webhookDeliveries` map grew without bound.

## Solution

- `pruneStaleWebhookDeliveries` removes terminal deliveries older than `OBLIVION_WEBHOOK_DELIVERY_RETENTION_DAYS` (default 30).
- Skips `pending` and failed deliveries still due for retry.
- Runs on maintenance scheduler in `app.ts`.

## Verify

`npm test -- test/domain/webhook-retention.test.ts`