# Plan 041: Normalize IPv4-mapped IPv6 in safe outbound URL checks

> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/domain/safeOutboundUrl.ts test/domain/safeOutboundUrl.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (extends plan 031 helper)
- **Category**: security
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

`isBlockedHost` checks dotted IPv4 and some IPv6 literals but not IPv4-mapped IPv6 forms like `::ffff:127.0.0.1`, which can bypass callback/webhook/handoff blocklists.

## Current state

```24:33:src/domain/safeOutboundUrl.ts
function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  // ...
  if (isPrivateIpv4(host)) return true;
}
```

Tests only cover dotted-quad loopback (`test/domain/safeOutboundUrl.test.ts`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/safeOutboundUrl.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/safeOutboundUrl.ts`
- `test/domain/safeOutboundUrl.test.ts`

**Out of scope**:
- Full IDNA/punycode normalization (unless trivial)

## Steps

### Step 1: Normalize hostname

In `isBlockedHost`, before checks:
- Strip `::ffff:` prefix (case-insensitive) and evaluate remainder with `isPrivateIpv4`
- Treat bare `[::ffff:127.0.0.1]` URL forms via `URL.hostname` parsing

**Verify**: tests pass

### Step 2: Regression tests

Add cases:
- `https://[::ffff:127.0.0.1]/x` → blocked
- `https://[::ffff:169.254.169.254]/` → blocked
- Public host still allowed

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Mapped-IPv6 loopback blocked
- [ ] `plans/README.md` row 041 → DONE

## STOP conditions

- Node `URL` parser normalizes mapped forms differently than expected — document actual behavior in test.

## Maintenance notes

Keep normalization in one function; plan 040 `safeOutboundFetch` must use the same `assertSafeOutboundHttpsUrl`.