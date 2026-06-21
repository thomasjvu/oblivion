# Plan 050: MemoryStore case-scoped indexes (PERF-03)

## Status: DONE

## Problem

`approvalsForCase`, `casesForPartner`, and `purgeCaseData` scanned full in-memory maps.

## Solution

- `CaseIndexedMap` maintains `caseId → ids` for all case-scoped entity maps.
- `CaseStoreMap` maintains `partnerId → case ids` for partner listings.
- `purgeCaseData` deletes via indexed lookups.

## Verify

`npm test -- test/storage/caseIndex.test.ts test/storage/memoryStore.test.ts`