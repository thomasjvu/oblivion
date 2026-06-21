# Plan 037: Block SSRF in execute handoff sourceUrl probes

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/connectorRuntime.ts src/domain/urlProbe.ts src/domain/executeHandoff.ts src/domain/safeOutboundUrl.ts test/domain/connectorRuntime.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/031-callback-url-ssrf-guard.md (shared safe URL helper)
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

Live platform-abuse execute calls `probeOfficialUrl(infringingUrl)` where `infringingUrl` comes from client-supplied execute `handoff.sourceUrl`. `urlProbe.ts` fetches with redirect follow and no private-network block. An approved action can still probe internal URLs from the server network.

## Current state

- `src/domain/connectorRuntime.ts:290-306` — `infringingUrl = input.handoff?.sourceUrl`; then `probeOfficialUrl(infringingUrl)`.
- `src/domain/urlProbe.ts:4-15` — unconditional `fetch(url, { redirect: "follow" })`.
- `src/api/routes/consumer/cases.ts` — execute body accepts `sourceUrl` in handoff.
- `src/domain/executeHandoff.ts:39-42` — builds handoff from client input.

Plan 031 adds `assertSafeOutboundHttpsUrl` — apply before any probe/fetch of user-supplied URLs.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/connectorRuntime.test.ts test/domain/urlProbe.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/safeOutboundUrl.ts` (from 031)
- `src/domain/connectorRuntime.ts` — validate handoff URL before probe
- `src/domain/urlProbe.ts` — optional internal guard for defense in depth
- `src/api/handlers/caseHandlers.ts` or execute route — early validation
- Tests with blocked hosts

**Out of scope**:
- Broker `officialOptOutUrl` probes (server-configured, not user input)
- Changing approval destination matching logic

## Steps

### Step 1: Validate handoff URL at execute boundary

In `handleExecute` (or `executeHandoff` builder), when `handoff.sourceUrl` present, call `assertSafeOutboundHttpsUrl`. Return 422 `handoff-url-blocked` on failure.

**Verify**: add unit test for handoff builder rejection

### Step 2: Guard in connector runtime

In `runPlatformAbuseLive` (or shared pre-probe helper), assert safe URL before `probeOfficialUrl`. Fail execution with clear `executionRecord` if blocked (do not fetch).

**Verify**: `npm test -- test/domain/connectorRuntime.test.ts` → pass

### Step 3: Defense in depth in urlProbe

Optional: `probeOfficialUrl` calls assert for http(s) URLs not on allowlist of internal config URLs. Skip if it breaks broker official URL probes — those use catalog URLs, not handoff.

**Verify**: existing connector tests still pass

### Step 4: Tests

- Execute with `handoff.sourceUrl: https://127.0.0.1/x` → 422 before connector runs
- Public URL still probes (mock fetch)

**Verify**: `npm run verify` → exit 0

## Test plan

- Blocked handoff rejected at API layer
- Live connector path does not fetch loopback

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Handoff SSRF regression test exists
- [ ] `plans/README.md` row 037 → DONE

## STOP conditions

- Plan 031 helper not merged — implement shared helper first or inline same blocklist.
- Platform-abuse flow requires non-HTTPS infringing URLs — report product decision.

## Maintenance notes

User-controlled URLs reaching `fetch` must use the shared helper. Align blocklist with plans 031 and 034.