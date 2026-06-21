# Plan 051: SQLite snapshot store

## Status: DONE

## Problem

024 spike deferred a durable store; JSON file snapshots work but SQLite is the Phala CVM target.

## Solution

- `OBLIVION_STORE=sqlite` persists the same `PersistedStoreSnapshot` JSON in `node:sqlite` (`data/oblivion.db` default).
- Shared `snapshot.ts` hydrate/snapshot helpers for file + SQLite backends.
- `OBLIVION_STORE_PATH` ending in `.db` also selects SQLite.

## Out of scope

Per-entity relational tables and multi-writer replication.

## Verify

`npm test -- test/storage/sqliteStore.test.ts`