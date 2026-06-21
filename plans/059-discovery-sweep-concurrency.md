# Plan 059: Discovery sweep concurrency parity with preview

## Status: DONE

## Problem

Broker sweep in full discovery used hardcoded concurrency while preview path respected `OBLIVION_PREVIEW_SEARCH_CONCURRENCY`.

## Solution

- `discoverySearchConcurrency()` — reads `OBLIVION_DISCOVERY_SEARCH_CONCURRENCY` or falls back to preview concurrency env (default 4, max 8).
- Passed to `fetchBrokerSweepCandidates()` in `discoverExposureCandidates`.

## Files

- `src/domain/exposureDiscovery.ts`

## Verify

`npm run verify`