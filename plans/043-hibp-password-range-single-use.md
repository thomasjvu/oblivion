# Plan 043: Consume HIBP password-range approvals on success

> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/api/routes/connectors.ts test/domain/connectors.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/038-hibp-approval-single-use.md (DONE — email only)
- **Category**: security
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

Plan 038 marked email-check approvals `used` after success. Password-range route still allows unlimited prefix lookups per approval, expanding HIBP oracle abuse and API cost.

## Current state

```49:65:src/api/routes/connectors.ts
    const range = await fetchHibpPasswordRange(body.hashPrefix);
    const result = buildHibpPasswordRangeConnectorResult(...);
    store.connectorResults.set(result.id, result);
    sendJson(response, 200, { result, ... });
    // no approval.status = "used"
```

Email route at line 92 sets `approval.status = "used"`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/connectors.test.ts test/api/` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/api/routes/connectors.ts`
- Connector API test (add or extend)

**Out of scope**:
- Policy matrix change unless tests require it

## Steps

### Step 1: Mark approval used

After successful password-range fetch, set `approval.status = "used"` (mirror email route).

**Verify**: manual read of both routes for parity

### Step 2: Single-use test

Add test: first call 200, second call with same `approvalId` → 403 `execution-blocked`.

Model after email-check test if present, or `test/api/app.test.ts` connector patterns.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Reuse rejected
- [ ] `plans/README.md` row 043 → DONE

## STOP conditions

- `policyMatrix` documents intentional multi-prefix per approval — update matrix + tests instead.

## Maintenance notes

Direct connector routes must consume approvals or delegate to `executeApprovedActionFlow`.