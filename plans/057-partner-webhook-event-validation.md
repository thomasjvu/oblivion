# Plan 057: Validate partner webhook event enum

## Status: DONE

## Problem

`POST /v1/webhooks` accepted arbitrary `events` strings; typos silently subscribed partners to nothing useful.

## Solution

- `PARTNER_WEBHOOK_EVENTS` — canonical event list in `partners.ts`.
- `parsePartnerWebhookEvents()` — 422 `webhook-event-invalid` with `allowed` list on unknown events; `webhook-events-required` on empty.

## Files

- `src/domain/partners.ts`
- `src/api/routes/v1/webhooks.ts`
- `test/domain/partner-webhook-events.test.ts`

## Verify

`npm test -- test/domain/partner-webhook-events.test.ts`