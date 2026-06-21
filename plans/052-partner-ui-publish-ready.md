# Plan 052: @oblivion/partner-ui publish-ready

## Status: DONE

## Problem

`partner-ui` was `private: true` with no README or publish wiring.

## Solution

- Removed `private: true`; added MIT license, repository metadata, README, `files` allowlist.
- `publish:partner-packages` includes `packages/partner-ui`.

## Ops

Run `npm run publish:partner-packages` when npm registry auth is configured.

## Verify

Inspect `packages/partner-ui/package.json` and README.