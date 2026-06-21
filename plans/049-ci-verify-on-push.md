# Plan 049: CI verify on push/PR (DX-01)

## Status: DONE

## Problem

`.github/workflows/verify.yml` ran only on `workflow_dispatch`.

## Solution

Added `push` and `pull_request` triggers on `main`.

## Verify

Push to branch; workflow runs `npm run verify` + `npm audit --audit-level=high`.