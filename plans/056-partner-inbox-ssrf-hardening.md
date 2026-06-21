# Plan 056: Partner inbox SSRF hardening

## Status: DONE

## Problem

Partner webhook inbox delivery URLs (`/v1/partners/:id/webhook-inbox`) bypassed strict HTTPS host checks. `redirect: "follow"` on outbound fetch could hop to private targets after an initial safe URL.

## Solution

- `assertSafePartnerInboxUrl()` — pathname match, origin must equal configured public API URL (HTTPS) or loopback in dev.
- `isLocalDevHost()` checked before `isBlockedHost` so `127.0.0.1` inbox URLs work in tests/dev.
- `safeOutboundFetch()` — manual redirect hops with per-hop validation for all URLs including inbox.
- `publicApiBaseForInboxRegistration()` — requires HTTPS `OBLIVION_PUBLIC_API_URL` or loopback `Host` for `register-inbox`.

## Files

- `src/domain/safeOutboundUrl.ts`
- `src/api/routes/v1/context.ts`
- `src/api/routes/v1/webhooks.ts`
- `test/domain/safeOutboundUrl.test.ts`

## Verify

`npm test -- test/domain/safeOutboundUrl.test.ts`