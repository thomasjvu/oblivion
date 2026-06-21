# Plan 024: Durable store behind OblivionRepository (design spike)

## Status: SPIKE — not implemented

## Current state

`MemoryStore` + optional `data/oblivion.json` snapshot (`createStore.ts`, `fileStore.ts`). `OblivionRepository` interface exists (`repository.ts`).

## Proposed direction

SQLite single-file DB for Phala CVM; preserve `purgeCaseData` semantics and never store decrypted intake.

## Out of scope for spike

Server-side vault decrypt, horizontal multi-writer without migration plan.