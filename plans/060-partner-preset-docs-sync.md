# Plan 060: Partner preset docs sync

## Status: DONE

## Problem

Partner API docs listed only two default presets; five are exposed on `GET /v1/presets`. Consumer-only exclusions and operator allowlist configuration were undocumented.

## Solution

- Updated `docs/src/docs/content/developers/partner-api.md` Templates section: all five default partner presets, consumer-only exclusions (`high-risk-safety`, `content-takedown`), operator allowlist note (no `OBLIVION_` env names — docs voice lint).

## Files

- `docs/src/docs/content/developers/partner-api.md`

## Verify

`npm run docs:build && npm run docs:verify`