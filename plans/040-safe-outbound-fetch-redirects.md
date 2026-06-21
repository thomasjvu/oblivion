# Plan 040: Block SSRF via redirect hops on outbound fetch

> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/domain/safeOutboundUrl.ts src/domain/urlProbe.ts src/domain/webhooks.ts src/domain/brokerWebForm.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/031-callback-url-ssrf-guard.md (DONE)
- **Category**: security
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

Plans 031/034/037 validate URLs at registration time. `fetch(..., { redirect: "follow" })` in `urlProbe.ts`, `webhooks.ts`, and `brokerWebForm.ts` can still reach loopback or metadata hosts after an HTTPS redirect from an allowed public URL.

## Current state

```4:15:src/domain/urlProbe.ts
    const head = await fetch(url, { method: "HEAD", redirect: "follow", headers });
// ...
    const get = await fetch(url, { method: "GET", redirect: "follow", headers, ... });
```

- `src/domain/webhooks.ts:107` — `postSignedWebhook` uses default redirect follow.
- `src/domain/safeOutboundUrl.ts` — static host blocklist only; no redirect validation.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/safeOutboundUrl.test.ts test/domain/urlProbe.test.ts test/domain/callback-webhook.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/safeOutboundUrl.ts` — add `safeOutboundFetch(url, init)` helper
- `src/domain/urlProbe.ts`, `src/domain/webhooks.ts`, `src/domain/brokerWebForm.ts` — use helper
- Tests with mocked `fetch` redirect chain to blocked host

**Out of scope**:
- DNS rebinding
- Partner inbox HTTP URLs (already exempt in `webhooks.ts`)

## Steps

### Step 1: Implement safeOutboundFetch

Add helper that:
- Uses `redirect: "manual"` or follows up to N hops (max 3)
- Calls `assertSafeOutboundHttpsUrl` on each hop URL before following
- Returns `Response` or throws `DomainError("outbound-url-blocked")`

**Verify**: unit tests in `test/domain/safeOutboundUrl.test.ts`

### Step 2: Route urlProbe and webhooks

Replace raw `fetch` in `probeOfficialUrl` and `postSignedWebhook` with `safeOutboundFetch`.

**Verify**: existing urlProbe and callback-webhook tests pass

### Step 3: Route brokerWebForm probes

Same for `brokerWebForm.ts` fetch calls.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Redirect to `127.0.0.1` blocked in tests
- [ ] Happy-path public HTTPS still works (mocked)
- [ ] `plans/README.md` row 040 → DONE

## STOP conditions

- Legitimate broker opt-out flows require >3 redirects — document and raise cap with test evidence.
- `redirect: manual` breaks Node fetch version in use — STOP and report Node version.

## Maintenance notes

All new server-side `fetch` to user-influenced URLs must use `safeOutboundFetch`, not raw `fetch`.