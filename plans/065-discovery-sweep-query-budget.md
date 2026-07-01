# Plan 065: Tune broker sweep query budget and deduplicate search variants

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 923f4d2..HEAD -- src/domain/brokerCatalog.ts src/domain/exposureDiscovery.ts test/domain/brokerCatalog.test.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `923f4d2`, 2026-06-30

## Why this matters

Full discover can issue up to ~50 Brave/Venice `site:` queries per run (default `BROKER_SWEEP_QUERY_CAP`), plus broad search, plus up to 40 profile-slug candidates — while only 25 candidates are scored. Plan 059 fixed concurrency parity but not query volume. Each discover debits 15 wallet credits and adds multi-second latency.

## Current state

- `src/domain/brokerCatalog.ts:195-201` — `brokerSweepQueryCap()` default **50** (max 80)
- `src/domain/brokerCatalog.ts:215-236` — up to ~6 variants per broker when region present
- `src/domain/exposureDiscovery.ts:388` — scores `filtered.slice(0, 25)` only
- `src/domain/brokerProfileUrls.ts` — up to 40 slug URLs without API cost
- Plan 059 (`plans/059-discovery-sweep-concurrency.md`) — DONE; concurrency only

Exemplar tests: `test/domain/brokerCatalog.test.ts`, `test/domain/exposureDiscovery.test.ts`

## Commands you will need

| Purpose   | Command           | Expected on success |
|-----------|-------------------|---------------------|
| Tests     | `npm test`        | exit 0              |
| Full gate | `npm run verify`  | exit 0              |

## Scope

**In scope**:
- `src/domain/brokerCatalog.ts`
- `src/domain/exposureDiscovery.ts` (if cap wiring lives here)
- `test/domain/brokerCatalog.test.ts`
- `.env.example` (document new env vars)

**Out of scope**:
- Merging preview/full pipelines (deferred)
- Changing credit debit amount

## Steps

### Step 1: Lower sensible defaults with env overrides

Change default `BROKER_SWEEP_QUERY_CAP` from 50 → **24** (or 30) unless env set. Document in `.env.example`:

```
BROKER_SWEEP_QUERY_CAP=24
OBLIVION_DISCOVERY_SWEEP_QUERY_CAP=24  # alias if preferred
```

Keep `brokerSweepLimit()` broker count aligned so cap is hit by priority brokers first (spokeo, truepeoplesearch, fastpeoplesearch, etc.).

**Verify**: `npx tsx --test test/domain/brokerCatalog.test.ts` → pass

### Step 2: Deduplicate identical queries within one sweep

In `fetchBrokerSweepCandidates` (`exposureDiscovery.ts`), dedupe `queries` array by `query` string before issuing fetches.

**Verify**: add unit test — two brokers producing identical `site:` string only fetch once (mock fetch counter).

### Step 3: Align profile-slug cap with scoring batch

Reduce `buildBrokerProfileUrlCandidates` default limit from 40 → **20** to match scoring batch headroom, or document why higher is useful (pasted + sweep + slug compete for 25 slots).

**Verify**: `npm test` → exit 0

## Test plan

- `buildBrokerSweepQueries` still includes region variant when `regionLabel` set
- Default cap produces fewer queries than old 50 default (assert in brokerCatalog test)
- Discover still returns results in mocked Brave test (`exposureDiscovery.test.ts`)

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Default full-discover issues ≤30 search API calls in typical name+region case (measure via test mock)
- [ ] `.env.example` documents caps
- [ ] `plans/README.md` row 065 → DONE

## STOP conditions

- Lower cap drops E2E/API test discovery below minimum assertions — tune cap not below test needs or update tests with mocks.
- Recall regression reported by product — stop and document tradeoff.

## Maintenance notes

- Monitor operator Brave bill after deploy.
- If recall drops, raise cap via env without code change.