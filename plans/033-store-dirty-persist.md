# Plan 033: Persist file store only when dirty

> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/storage/fileStore.ts src/storage/memoryStore.ts src/api/app.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: performance
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

`src/api/app.ts:177` calls `scheduleStorePersist` in the handler `finally` for every request, including static assets and `GET /health`. Each debounced flush serializes the entire store (`fileStore.ts:98-125`). Static traffic prevents efficient debouncing and wastes I/O.

## Current state

- `src/api/app.ts:176-178` — unconditional `scheduleStorePersist`.
- `src/storage/fileStore.ts:130-143` — 300ms debounce, full snapshot write.
- `src/storage/memoryStore.ts` — no dirty flag.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/storage/fileStore.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/storage/memoryStore.ts` — `dirty` flag + `markDirty()` / `clearDirty()`
- `src/storage/fileStore.ts` — skip persist when not dirty; clear after write
- `src/api/app.ts` — only schedule when `store.dirty`
- `test/storage/fileStore.test.ts`

**Out of scope**:
- Incremental/chunked snapshots (future)
- SQLite backend (plan 024 direction)

## Steps

### Step 1: Dirty flag on MemoryStore

Add `dirty = false`, method `markDirty()` called from all mutating `set` paths (or centralize in a thin wrapper).

Expose `isDirty()` for app handler.

**Verify**: unit test dirty flips on `cases.set`

### Step 2: Gate scheduleStorePersist

In `app.ts` finally block: `if (persistPath && store.isDirty()) scheduleStorePersist(...)`.

In `persistStore`, after successful write, `store.clearDirty()`.

**Verify**: `npm test -- test/storage/fileStore.test.ts` → pass

### Step 3: Ensure mutations always mark dirty

Audit `MemoryStore` public mutation paths; add `markDirty()` if any map writes bypass it.

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Read-only requests do not schedule persist
- [ ] Mutations still persist within debounce window
- [ ] `plans/README.md` row 033 → DONE

## STOP conditions

- Cannot find all mutation paths; risk of silent data loss.
- Tests use shared file store and break due to dirty semantics (fix test helpers instead).

## Maintenance notes

New store collections must call `markDirty()` on write. Consider entity registry (ARCH-04) later.