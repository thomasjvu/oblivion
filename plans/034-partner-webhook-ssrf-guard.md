# Plan 034: Block SSRF targets in partner webhookUrl delivery

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/webhooks.ts src/api/routes/v1/webhooks.ts src/domain/safeOutboundUrl.ts test/api/partner-webhooks.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/031-callback-url-ssrf-guard.md (shared `safeOutboundUrl` helper)
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

Authenticated partners register `webhookUrl` via `POST /v1/webhooks` with HTTPS prefix validation only. Oblivion then POSTs signed event payloads to that URL from the server process. Without host policy, partners can aim webhooks at loopback, RFC1918, link-local, or cloud metadata addresses — a server-side request gadget distinct from per-case `callbackUrl` (plan 031).

## Current state

- `src/api/routes/v1/webhooks.ts:27-28` — `body.url?.startsWith("https://")` only.
- `src/domain/webhooks.ts:94-103` — `postSignedWebhook` fetches arbitrary URL.
- `src/domain/webhooks.ts:111-121` — `postWebhook` / `dispatchPartnerWebhook` use partner `webhookUrl`.
- Plan 031 introduces `src/domain/safeOutboundUrl.ts` with `assertSafeCallbackUrl` — reuse or rename to shared `assertSafeOutboundHttpsUrl`.

Error handling: routes throw `HttpError`; domain uses `DomainError`. Match existing webhook tests in `test/api/partner-webhooks.test.ts` or `test/domain/webhook-delivery.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/api/partner-webhooks.test.ts test/domain/webhook-delivery.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/safeOutboundUrl.ts` (from plan 031 — extend if needed)
- `src/api/routes/v1/webhooks.ts` — validate on register
- `src/domain/webhooks.ts` — validate in `postSignedWebhook` before `fetch`
- Tests for blocked hosts (`127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `localhost`)

**Out of scope**:
- DNS rebinding beyond hostname blocklist
- Case `callbackUrl` (plan 031)
- Execute handoff URLs (plan 037)

## Steps

### Step 1: Reuse safe URL helper from plan 031

If plan 031 is not merged yet, implement the same helper here. Export `assertSafeOutboundHttpsUrl(url: string): void` that:
- Requires `https:` scheme
- Blocks loopback, private, link-local, and metadata hostnames/IPs
- Throws `DomainError` with code `outbound-url-blocked` (422)

**Verify**: unit test in `test/domain/safeOutboundUrl.test.ts` or extend callback-webhook tests → pass

### Step 2: Validate on partner webhook registration

In `handleV1WebhookRoutes` when `POST /v1/webhooks`, after HTTPS check, call `assertSafeOutboundHttpsUrl(body.url.trim())`. Map `DomainError` to `HttpError` at route boundary if needed.

**Verify**: `npm test -- test/api/partner-webhooks.test.ts` → pass

### Step 3: Validate before outbound fetch

In `postSignedWebhook` (or wrapper), call `assertSafeOutboundHttpsUrl(url)` before `fetch`. Return `{ ok: false, error: "outbound-url-blocked" }` if validation fails inside async path (do not throw uncaught).

**Verify**: add test that partner with blocked URL gets delivery failure without server crash

### Step 4: Regression tests

Add tests:
- `POST /v1/webhooks` with `https://127.0.0.1/hook` → 422
- Delivery attempt to pre-registered blocked URL → logged failure, no fetch to loopback (mock `fetch` if needed)

**Verify**: `npm run verify` → exit 0

## Test plan

- Registration rejects blocked hosts.
- Existing happy-path webhook delivery still works for public HTTPS URLs.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Blocked-host negative tests exist
- [ ] `plans/README.md` row 034 → DONE

## STOP conditions

- Plan 031 helper API differs materially from excerpts — reconcile names before duplicating logic.
- Production partners already use internal URLs that must keep working (report before blocking).

## Maintenance notes

Any new outbound `fetch` from server (webhooks, probes, connectors) should call the shared safe-URL helper. Plan 037 extends the same helper to execute handoffs.