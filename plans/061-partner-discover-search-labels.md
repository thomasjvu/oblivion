# Plan 061: Partner discover `searchLabels` parity with consumer API

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 923f4d2..HEAD -- src/api/routes/v1/cases.ts src/api/handlers/caseHandlers.ts packages/partner-sdk/ spec/openapi-v1.yaml test/api/partner.test.ts`
> If in-scope files changed since this plan was written, compare "Current state" excerpts against live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (consumer `searchLabels` path should already exist locally; if not, implement consumer handler first)
- **Category**: direction
- **Planned at**: commit `923f4d2`, 2026-06-30

## Why this matters

Consumer discover accepts ephemeral `searchLabels` (full name + region for this request only) so broker sweep queries work. Partner `/v1/cases/:id/discover` only accepts `pastedUrls`, and `packages/partner-sdk` mirrors that gap. Partner and agent automation therefore fall back to persisted initials in `redactedScope`, reproducing the weak people-search behavior the consumer path just fixed.

## Current state

- `src/api/handlers/caseHandlers.ts` — `DiscoverBody` includes optional `searchLabels`; `handleCaseDiscover` calls `validateDiscoverySearchLabels` and passes labels to `discoverExposureCandidates`.
- `src/domain/discoverySearchLabels.ts` — `validateDiscoverySearchLabels` rejects forbidden secrets; labels are not written to the case record.
- `src/api/routes/v1/cases.ts:248-260` — partner discover reads `{ pastedUrls?: string[] }` only; passes `body` to `handleCaseDiscover` (extra fields are currently ignored if not typed/parsed).
- `packages/partner-sdk/index.js:55-59` — `discover(caseId, pastedUrls)` sends only `pastedUrls`.
- `spec/openapi-v1.yaml` — `/v1/cases/{id}/discover` has no request body schema for `searchLabels`.
- Convention: partner routes use shared handlers; never store full legal names in `redactedScope` (see `AGENTS.md` partner rail).

Exemplar test pattern: `test/api/findings.test.ts` (consumer discover with `searchLabels` and `discoveryPlan.searchMode === "ephemeral"`).

## Commands you will need

| Purpose   | Command           | Expected on success |
|-----------|-------------------|---------------------|
| Tests     | `npm test`        | exit 0, all pass    |
| Typecheck | `npm run typecheck` | exit 0            |
| Full gate | `npm run verify`  | exit 0              |

## Scope

**In scope**:
- `src/api/routes/v1/cases.ts`
- `packages/partner-sdk/index.js`
- `packages/partner-sdk/README.md` (if exists; otherwise add discover section)
- `spec/openapi-v1.yaml`
- `test/api/partner.test.ts` or new `test/api/partner-discover.test.ts`
- `docs/src/docs/content/developers/partner-api.md` (discover section only)

**Out of scope**:
- `src/domain/recheck.ts` — recheck labels are plan 062 follow-up
- Consumer routes — already implemented
- Persisting `searchLabels` on `CaseRecord`

## Git workflow

- Branch: `advisor/061-partner-discover-search-labels`
- Commit style: match repo (`fix(partner): …` or `feat(v1): …` per recent `git log`)

## Steps

### Step 1: Extend partner discover request typing

In `src/api/routes/v1/cases.ts`, change the discover body type to:

```typescript
{ pastedUrls?: string[]; searchLabels?: { personLabel: string; aliases?: string[]; regionLabel?: string } }
```

No handler changes needed if `handleCaseDiscover` already consumes `body.searchLabels`.

**Verify**: `npm run typecheck` → exit 0

### Step 2: Add partner API test

Add a test (extend `test/api/partner.test.ts` or new file) that:
1. Creates a partner case with `redactedScope.personLabel: "J.S."`
2. Calls `POST /v1/cases/:id/discover` with `searchLabels: { personLabel: "Jane Doe", regionLabel: "Boston, MA" }`
3. Asserts `discoveryPlan.searchMode === "ephemeral"` in the response

Mock Brave like `test/api/findings.test.ts` if keys would otherwise hit network.

**Verify**: `npx tsx --test test/api/partner*.test.ts` → new test passes

### Step 3: Update partner SDK

Change `packages/partner-sdk/index.js`:

```javascript
discover(caseId, options = {}) {
  const body = typeof options === "object" && options !== null && !Array.isArray(options)
    ? options
    : { pastedUrls: options };
  return this.request(`/v1/cases/${caseId}/discover`, { method: "POST", body });
}
```

Preserve backward compatibility: `discover(caseId, ["https://..."])` still works if you normalize array → `{ pastedUrls }`.

Document optional `searchLabels` in partner SDK README.

**Verify**: `npm test` → exit 0 (including `test/packages/` if partner-sdk is tested)

### Step 4: OpenAPI + partner docs

Add optional `searchLabels` object to `spec/openapi-v1.yaml` discover request body (mirror consumer shape).

In `docs/src/docs/content/developers/partner-api.md`, document:
- `searchLabels` is ephemeral (not stored on case)
- Partners must not put full legal names in `redactedScope`
- `discoveryPlan.searchMode` values `ephemeral` | `redacted`

**Verify**: `npm run docs:verify` → exit 0 (if docs CI applies)

## Test plan

- Partner discover with `searchLabels` returns `searchMode: "ephemeral"`
- Partner discover without `searchLabels` still works (redacted fallback)
- SDK array `pastedUrls` backward compat

Pattern: `test/api/findings.test.ts`

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Partner discover accepts `searchLabels` and returns ephemeral `discoveryPlan`
- [ ] `packages/partner-sdk` documents and sends optional `searchLabels`
- [ ] OpenAPI v1 documents request field
- [ ] `plans/README.md` row 061 → DONE

## STOP conditions

- `handleCaseDiscover` does not accept `searchLabels` on `DiscoverBody` (consumer path missing) — stop; implement consumer handler first or report drift.
- Partner policy forbids ephemeral labels — stop and report product decision needed.

## Maintenance notes

- Recheck (`src/domain/recheck.ts`) still uses redacted scope only; track as follow-up plan 062/067.
- Reviewers: confirm no code path writes `searchLabels` into `caseRecord.redactedScope` or logs.