# Plan 044: Cap partner run-until-blocked maxIterations

> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/api/routes/v1/cases.ts src/domain/partnerAgent.ts test/api/partner-agent.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

`POST /v1/cases/:id/run-until-blocked` passes client `maxIterations` through with no upper bound. A stolen partner API key can request billions of agent steps, burning CPU and external discovery/AI quotas.

## Current state

```149:154:src/api/routes/v1/cases.ts
    const body = await readJson<{ maxIterations?: number }>(request);
    const result = await runPartnerAgentUntilBlocked({
      ...
      maxIterations: body.maxIterations
    });
```

```22:26:src/domain/partnerAgent.ts
  const maxIterations = input.maxIterations ?? 12;
  while (iterations < maxIterations) {
```

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/api/partner-agent.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/api/routes/v1/cases.ts` — validate/clamp `maxIterations` (1–50)
- `src/domain/partnerAgent.ts` — defensive clamp as belt-and-suspenders
- `test/api/partner-agent.test.ts`

**Out of scope**:
- OpenAPI doc sync (optional one-line note)

## Steps

### Step 1: Validate at API boundary

Reject non-finite, <1, or >50 with `HttpError(422, "max-iterations-out-of-range")`. Default remains 12 when omitted.

**Verify**: partner agent tests pass

### Step 2: Negative test

POST `run-until-blocked` with `maxIterations: 999` → 422.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Cap enforced at API
- [ ] `plans/README.md` row 044 → DONE

## STOP conditions

- Product requires >50 for a named partner — use env override instead of raising global cap without approval.

## Maintenance notes

Document cap in partner API docs when docs plan lands.