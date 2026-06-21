import { join } from "node:path";
import { persistenceStore } from "../domain/integrations.js";
import { createPersistentStore } from "./fileStore.js";
import { MemoryStore } from "./memoryStore.js";
import { createSqliteStore } from "./sqliteStore.js";

function isSqliteStorePath(path: string): boolean {
  return path.endsWith(".db") || path.endsWith(".sqlite");
}

export function createAppStore(): MemoryStore {
  const mode = persistenceStore();
  const path = process.env.OBLIVION_STORE_PATH?.trim();
  if (mode === "sqlite") {
    return createSqliteStore(path ?? join(process.cwd(), "data", "oblivion.db"));
  }
  if (path) {
    if (isSqliteStorePath(path)) return createSqliteStore(path);
    return createPersistentStore(path);
  }
  if (mode === "file") {
    return createPersistentStore(join(process.cwd(), "data", "oblivion.json"));
  }
  return new MemoryStore();
}

export function storePersistPath(): string | null {
  const mode = persistenceStore();
  const explicit = process.env.OBLIVION_STORE_PATH?.trim();
  if (mode === "sqlite") {
    return explicit ?? join(process.cwd(), "data", "oblivion.db");
  }
  if (explicit) return explicit;
  if (mode === "file") return join(process.cwd(), "data", "oblivion.json");
  return null;
}