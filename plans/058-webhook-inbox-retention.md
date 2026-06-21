# Plan 058: Partner webhook inbox retention

## Status: DONE

## Problem

`partnerWebhookInbox` map grew without bound (PERF-01 sibling to delivery retention in plan 046).

## Solution

- `pruneStaleWebhookInboxEntries()` — TTL via `OBLIVION_WEBHOOK_INBOX_RETENTION_DAYS` (default 30) and per-partner cap via `OBLIVION_WEBHOOK_INBOX_MAX_ENTRIES_PER_PARTNER` (default 500).
- Runs on maintenance scheduler in `app.ts` alongside `pruneStaleWebhookDeliveries`.

## Files

- `src/domain/webhooks.ts`
- `src/api/app.ts`
- `test/domain/webhook-retention.test.ts`

## Verify

`npm test -- test/domain/webhook-retention.test.ts`