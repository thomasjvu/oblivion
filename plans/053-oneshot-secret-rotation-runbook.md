# Plan 053: 1Shot secret rotation runbook

## Status: DONE

## Problem

Plan 035 fixed HMAC verification; operators need a post-deploy rotation step.

## Solution

Added step 10 to `SECURITY.md` Production Runbook: rotate `ONESHOT_API_KEY` via Infisical push + redeploy + revoke old key.

## Verify

Read `SECURITY.md` § Production Runbook step 10.