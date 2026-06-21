# Plan 031: Block SSRF targets in partner case callbackUrl delivery

> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/webhooks.ts src/domain/cases.ts test/domain/callback-webhook.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

Partners can set `callbackUrl` on case create (`https://` prefix only). `dispatchCaseCallbackWebhook` POSTs signed payloads to that URL from the server. Without host policy, callbacks can target loopback, RFC1918, or cloud metadata addresses reachable from the Oblivion host.

## Current state

- `src/domain/cases.ts:33-35` — HTTPS prefix check only.
- `src/domain/webhooks.ts:124-147` — `postSignedWebhook(callbackUrl, ...)`.
- `test/domain/callback-webhook.test.ts` — happy path only.

Reuse patterns from `src/domain/urlProbe.ts` or add `src/domain/safeOutboundUrl.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/callback-webhook.test.ts test/domain/cases.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- New `src/domain/safeOutboundUrl.ts` (or extend `urlProbe.ts`)
- `src/domain/cases.ts` — validate on create
- `src/domain/webhooks.ts` — validate before fetch
- Tests

**Out of scope**:
- Partner `webhookUrl` registration (separate hardening pass)
- DNS rebinding mitigation beyond hostname blocklist

## Steps

### Step 1: URL policy helper

Implement `assertSafeCallbackUrl(url: string): void` that:
- Parses with `URL` constructor
- Requires `https:` protocol
- Rejects hostnames: `localhost`, `127.0.0.1`, `::1`, `169.254.169.254`, private IP ranges (10/8, 172.16/12, 192.168/16)
- Throws `DomainError("callback-url-not-allowed", 422)`

**Verify**: unit tests in `test/domain/safeOutboundUrl.test.ts`

### Step 2: Apply at create and dispatch

Call helper in `createCaseRecord` when `callbackUrl` set, and in `dispatchCaseCallbackWebhook` before fetch.

**Verify**: `npm test -- test/domain/cases.test.ts test/domain/callback-webhook.test.ts` → pass

### Step 3: Negative tests

Test `http://evil` rejected at create.
Test `https://127.0.0.1/hook` rejected.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Private/loopback callback URLs rejected
- [ ] Existing happy-path callback test still passes
- [ ] `plans/README.md` row 031 → DONE

## STOP conditions

- Product requires callbacks to partner-side localhost tunnels (report for allowlist design).

## Maintenance notes

Log callback hostname only via `sanitizeForLog`; never log secrets or full signed body.