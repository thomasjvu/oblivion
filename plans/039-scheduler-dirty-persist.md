# Plan 039: Mark store dirty on scheduler and mutating GET paths

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c4c1bc8..HEAD -- src/api/app.ts src/storage/memoryStore.ts src/storage/fileStore.ts src/domain/recheck.ts src/domain/webhooks.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/033-store-dirty-persist.md (DONE)
- **Category**: correctness
- **Planned at**: commit `c4c1bc8`, 2026-06-21

## Why this matters

Plan 033 only calls `markDirty()` for non-GET `/api/*` and `/v1/*` requests in `app.ts` `finally`. Background `setInterval` work (`processDueRechecks`, `processDueWebhookRetries`) and some GET handlers that write audit rows mutate `MemoryStore` without marking dirty, so changes never reach `data/oblivion.json` until a later POST happens.

## Current state

```177:200:src/api/app.ts
      if (mutatesStore) store.markDirty();
      if (persistPath) scheduleStorePersist(store, persistPath);
// ...
      ? setInterval(() => {
          if (webhookSchedulerEnabled) void processDueWebhookRetries(store);
          if (maintenanceSchedulerEnabled) void processDueRechecks(store);
        }, webhookRetryIntervalMs)
```

- `grep markDirty` — only `app.ts` and tests call it; schedulers do not.
- `src/storage/fileStore.ts` — `scheduleStorePersist` no-ops when `!store.isDirty()`.
- Pattern: `store.markDirty()` / `store.isDirty()` on `MemoryStore` (`src/storage/memoryStore.ts`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Storage tests | `npm test -- test/storage/` | all pass |
| Full gate | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/api/app.ts` — mark dirty + schedule after scheduler ticks when `persistPath` set
- `src/domain/recheck.ts`, `src/domain/webhooks.ts` — optional `store.markDirty()` at end of mutating exports (if cleaner than app-only)
- `test/storage/schedulerPersist.test.ts` (new)

**Out of scope**:
- SQLite store (024 direction)
- Changing debounce interval

## Steps

### Step 1: Dirty + persist after maintenance scheduler

In `createApp`, when `webhookRetryTimer` fires and either branch runs, after `await processDueWebhookRetries` / `processDueRechecks` (wrap void IIFE with async), if `persistPath`: `store.markDirty(); scheduleStorePersist(store, persistPath)`.

**Verify**: `npm test -- test/domain/recheck.test.ts` → pass

### Step 2: Scheduler persist regression test

Add `test/storage/schedulerPersist.test.ts`:
- MemoryStore + `processDueRechecks` (seed due follow-up)
- `store.markDirty()` (simulating scheduler fix) + `persistStore` + `loadFileStore`
- Assert follow-up status `triggered` survives reload

**Verify**: `npm test -- test/storage/schedulerPersist.test.ts` → pass

### Step 3: Mutating GET audit paths (optional if time)

If `GET /v1/cases/:id/export` or `GET /v1/webhooks/deliveries` triggers writes, call `store.markDirty()` in those handlers or document as acceptable ephemeral audit (prefer mark dirty for export access log).

**Verify**: `npm run verify` → exit 0

## Done criteria

- [ ] Scheduler mutations trigger dirty + persist when file store enabled
- [ ] Reload test proves recheck state survives persist
- [ ] `plans/README.md` row 039 → DONE

## STOP conditions

- Scheduler runs in same process without `persistPath` in tests — use direct `persistStore` in test only.
- Marking dirty on every scheduler tick causes unacceptable I/O — report measured cost before disabling.

## Maintenance notes

Any new background writer (cron, queue worker) must call `markDirty()` before `scheduleStorePersist`. Consider centralizing via a `mutateStore(store, fn)` helper in a follow-up.