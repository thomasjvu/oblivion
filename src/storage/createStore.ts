import { join } from "node:path";
import { persistenceStore } from "../domain/integrations.js";
import { createPersistentStore } from "./fileStore.js";
import { MemoryStore } from "./memoryStore.js";

export function createAppStore(): MemoryStore {
  const path = process.env.OBLIVION_STORE_PATH?.trim();
  if (path) return createPersistentStore(path);
  if (persistenceStore() === "file") {
    return createPersistentStore(join(process.cwd(), "data", "oblivion.json"));
  }
  return new MemoryStore();
}

export function storePersistPath(): string | null {
  const explicit = process.env.OBLIVION_STORE_PATH?.trim();
  if (explicit) return explicit;
  if (persistenceStore() === "file") return join(process.cwd(), "data", "oblivion.json");
  return null;
}