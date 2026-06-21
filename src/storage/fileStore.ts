import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore } from "./memoryStore.js";
import { hydrateStoreFromSnapshot, snapshotStore, type PersistedStoreSnapshot } from "./snapshot.js";
import { persistSqliteStore } from "./sqliteStore.js";

export type { PersistedStoreSnapshot } from "./snapshot.js";
export { hydrateStoreFromSnapshot, snapshotStore } from "./snapshot.js";

export function loadFileStore(path: string): MemoryStore {
  const store = new MemoryStore();
  try {
    const raw = readFileSync(path, "utf8");
    const snapshot = JSON.parse(raw) as PersistedStoreSnapshot;
    hydrateStoreFromSnapshot(store, snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return store;
}

let saveTimer: NodeJS.Timeout | null = null;

export function scheduleStorePersist(store: MemoryStore, path: string): void {
  if (!store.isDirty()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistStore(store, path);
  }, 300);
}

function isSqliteStorePath(path: string): boolean {
  return path.endsWith(".db") || path.endsWith(".sqlite");
}

export function persistStore(store: MemoryStore, path: string): void {
  if (!store.isDirty()) return;
  if (isSqliteStorePath(path)) {
    persistSqliteStore(store, path);
    return;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${path.split("/").pop() ?? "oblivion"}.tmp-${process.pid}`);
  writeFileSync(tempPath, JSON.stringify(snapshotStore(store)), "utf8");
  renameSync(tempPath, path);
  store.clearDirty();
}

export function createPersistentStore(path: string): MemoryStore {
  return loadFileStore(path);
}