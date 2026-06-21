import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hydrateStoreFromSnapshot, snapshotStore, type PersistedStoreSnapshot } from "./snapshot.js";
import { MemoryStore } from "./memoryStore.js";

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS store_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return db;
}

export function loadSqliteStore(path: string): MemoryStore {
  const store = new MemoryStore();
  const db = openDatabase(path);
  const row = db.prepare("SELECT data FROM store_snapshot WHERE id = 1").get() as
    | { data: string }
    | undefined;
  db.close();
  if (!row?.data) return store;
  const snapshot = JSON.parse(row.data) as PersistedStoreSnapshot;
  hydrateStoreFromSnapshot(store, snapshot);
  return store;
}

export function persistSqliteStore(store: MemoryStore, path: string): void {
  if (!store.isDirty()) return;
  const db = openDatabase(path);
  const data = JSON.stringify(snapshotStore(store));
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO store_snapshot (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(data, updatedAt);
  db.close();
  store.clearDirty();
}

export function createSqliteStore(path: string): MemoryStore {
  return loadSqliteStore(path);
}