# Plan 064: Document ephemeral searchLabels and fix discovery preview quota drift

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 923f4d2..HEAD -- docs/ spec/openapi-consumer.yaml SECURITY.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `923f4d2`, 2026-06-30

## Why this matters

Integrators and operators cannot discover the consumer quality fix from docs: `searchLabels`, `searchMode`, and profile-slug discovery are implemented in code/tests but absent from `docs/` and OpenAPI. Preview daily cap docs say "3" while code defaults to 5 in production — operators hit surprise quota behavior.

## Current state

- `docs/src/docs/content/developers/consumer-api.md:84-91` — discover section mentions `walletAddress` only; preview cap "default 3"
- `src/domain/discoveryPreview.ts:26-37` — `PRODUCTION_PREVIEW_DAILY_LIMIT = 5`
- `spec/openapi-consumer.yaml` — `/findings/discover` lacks request body properties for `searchLabels`, `pastedUrls`
- `SECURITY.md:145-149` — discovery preview section exists; extend with ephemeral labels policy
- `describeDiscoveryPlan` returns `searchMode: "ephemeral" | "redacted"` (`src/domain/exposureDiscovery.ts`)

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Docs CI   | `npm run docs:verify` | exit 0             |
| Full gate | `npm run verify`     | exit 0              |

## Scope

**In scope**:
- `docs/src/docs/content/developers/consumer-api.md`
- `spec/openapi-consumer.yaml` (minimal request properties only)
- `SECURITY.md` (discovery preview + ephemeral labels subsection)
- `Agents.md` (one paragraph on discovery search modes — only if maintainer wants agent doc sync)

**Out of scope**:
- Full OpenAPI response schemas (deferred in plan 048)
- Partner docs (plan 061)

## Steps

### Step 1: Fix consumer-api.md discover section

Document:

```markdown
### POST /api/cases/:id/findings/discover body (optional fields)
- `pastedUrls`: string[]
- `searchLabels`: { personLabel, aliases?, regionLabel? } — ephemeral; not stored on case
- `walletAddress`: for credits/subscription

Response `discoveryPlan.searchMode`: `ephemeral` | `redacted`
```

Update preview cap to **5** per `previewDailyLimit()` or document `OBLIVION_PREVIEW_DAILY_LIMIT` env override.

**Verify**: `grep -n "searchLabels" docs/src/docs/content/developers/consumer-api.md` → matches

### Step 2: OpenAPI consumer request properties

Add to `spec/openapi-consumer.yaml` discover POST minimal schema:

```yaml
searchLabels:
  type: object
  properties:
    personLabel: { type: string }
    aliases: { type: array, items: { type: string } }
    regionLabel: { type: string }
pastedUrls:
  type: array
  items: { type: string }
```

**Verify**: `npm run docs:verify` → exit 0

### Step 3: SECURITY.md ephemeral labels note

Add bullet under "Discovery preview":
- Ephemeral `searchLabels` on discover are validated, redacted for secrets, never persisted on `CaseRecord`, never logged in plaintext.
- Third-party search (Brave/Venice) receives labels only during the request (same class as preview).

**Verify**: manual read — no secret values in file

## Done criteria

- [ ] `npm run docs:verify` exits 0
- [ ] consumer-api.md documents `searchLabels` and correct preview cap
- [ ] openapi-consumer.yaml lists discover request fields
- [ ] `plans/README.md` row 064 → DONE

## STOP conditions

- OpenAPI generator breaks CI — reduce to docs-only change and note OpenAPI deferral.

## Maintenance notes

- When partner parity lands (061), mirror doc section in partner-api.md.