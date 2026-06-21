# Plan 048: Consumer OpenAPI parity (DEBT-01)

## Status: DONE (expanded route catalog)

## Problem

`openapi-consumer.yaml` documented only a handful of routes; CI checked minimal keys only.

## Solution

- Canonical spec at `spec/openapi-consumer.yaml` (mirrors v1 layout).
- `openapi:verify` syncs to `docs/public/` and asserts required route catalog + `caseAccessToken` security scheme.

## Out of scope

Full request/response schemas for every consumer route (plan 016 partial remains adequate for handlers).

## Verify

`npm run openapi:verify`