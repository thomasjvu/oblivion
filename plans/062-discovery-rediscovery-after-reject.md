# Plan 062: Fix discovery auto-run after all-rejected and agent re-sweep semantics

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 923f4d2..HEAD -- public/src/discoveryUi.js src/domain/agentRunner.ts src/domain/cleanup/planAdvancement.ts test/domain/agentPlanTransitions.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `923f4d2`, 2026-06-30

## Why this matters

When users mark every discovery hit as "Not me", rejected exposures remain in `findings` but not in `pendingFindings`. Client `needsExposureDiscovery()` treats `total > 0` as "discovery done" and blocks auto-discovery. Server `agentRunner` skips discovery whenever *any* exposure exists — including rejected-only sets — so agent automation never re-sweeps. Users get stuck unless they manually click "Search again".

## Current state

**Client** — `public/src/discoveryUi.js:62-68`:

```javascript
function needsExposureDiscovery() {
  ...
  const pending = state.currentStatus?.pendingFindings?.length ?? 0;
  const total = state.currentStatus?.findings?.length ?? 0;
  return pending === 0 && total === 0;
}
```

**Server plan advancement** — `src/domain/cleanup/planAdvancement.ts:69-77` blocks when `findingsCount + pendingFindingsCount === 0` (pending + confirmed only; rejected don't count toward `findingsCount` in blocked check — verify `buildAgentNextStep` inputs).

**Agent runner** — `src/domain/agentRunner.ts:74-78`:

```typescript
const existingExposures = input.store.exposuresForCase(input.caseRecord.id);
const discovered =
  existingExposures.length > 0
    ? []
    : await discoverExposureCandidates({ ... });
```

**Status builder** — `src/domain/status.ts:15-16` — `confirmedFindings` and `pendingFindings` are separate; rejected stay in `findings` only.

Exemplar: align client logic with server `planAdvancement.ts` discovery-needed branch.

## Commands you will need

| Purpose   | Command           | Expected on success |
|-----------|-------------------|---------------------|
| Tests     | `npm test`        | exit 0              |
| Client    | `npm run build:client` | exit 0         |
| Full gate | `npm run verify`  | exit 0              |

## Scope

**In scope**:
- `public/src/discoveryUi.js`
- `src/domain/agentRunner.ts`
- `test/domain/agentRunner.test.ts` (create if missing) or extend `test/domain/agentPlanTransitions.test.ts`
- `test/domain/exposureDiscovery.test.ts` (only if agent tests live there)

**Out of scope**:
- Partner `searchLabels` (plan 061)
- Changing reject persistence semantics
- E2E (plan 063)

## Steps

### Step 1: Fix client `needsExposureDiscovery`

Change to match server intent — need discovery when no pending and no confirmed:

```javascript
const pending = state.currentStatus?.pendingFindings?.length ?? 0;
const confirmed = state.currentStatus?.confirmedFindings?.length ?? 0;
return pending === 0 && confirmed === 0;
```

**Verify**: `npm run build:client` → exit 0

### Step 2: Fix agentRunner discover-candidates branch

Replace `existingExposures.length > 0` skip with reviewable check:

```typescript
const existingExposures = input.store.exposuresForCase(input.caseRecord.id);
const hasReviewable = existingExposures.some(
  (e) => e.matchStatus === "pending" || e.matchStatus === "confirmed"
);
const discovered = hasReviewable
  ? []
  : await discoverExposureCandidates({ ... existingUrls from all exposures for dedup ... });
```

Keep `existingUrls` as all exposure URLs (including rejected) for deduplication.

**Verify**: `npm run typecheck` → exit 0

### Step 3: Add regression tests

Add unit test asserting:
- When case has only `matchStatus: "rejected"` exposures, `runCleanupAgentStep` at `discover-candidates` still calls discovery (mock/spy `discoverExposureCandidates` or assert timeline mentions discovery when Brave configured / profile-slug path returns candidates).

If mocking is heavy, add a focused test on a small exported helper or test `hasReviewable` logic via agentRunner with MemoryStore fixtures (see `test/helpers/http.ts` patterns).

**Verify**: `npx tsx --test test/domain/agentPlanTransitions.test.ts test/domain/agentRunner.test.ts` → pass

## Test plan

- Client: rejected-only findings → `needsExposureDiscovery()` returns true when step is `discover-candidates`
- Server: rejected-only exposures → agent discover step runs `discoverExposureCandidates`
- Regression: pending exposures still skip re-discovery (no duplicate spam)

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] All-rejected case can auto-discover again without manual force-only workaround
- [ ] Pending/confirmed cases do not re-discover on every agent tick
- [ ] `plans/README.md` row 062 → DONE

## STOP conditions

- `buildAgentNextStep` uses different counting than assumed — stop and align client to actual server fields after reading `src/domain/status.ts` and `planAdvancement.ts`.
- Fix causes duplicate exposures on every agent run with pending findings — revert and report.

## Maintenance notes

- Agent runner still won't pass `searchLabels` (server cannot decrypt vault); partner parity is plan 061.
- Reviewers: ensure skip logic uses `matchStatus`, not `removalStatus`.