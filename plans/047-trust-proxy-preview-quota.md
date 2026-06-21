# Plan 047: TRUST_PROXY for preview quota client IP

## Status: DONE

## Problem

`X-Forwarded-For` was always trusted for discovery preview quota, allowing spoofing when not behind a proxy.

## Solution

- `OBLIVION_TRUST_PROXY=true` enables `X-Forwarded-For` in `clientIp()`.
- Default: socket `remoteAddress` only.

## Verify

`npm test -- test/api/clientIp.test.ts`