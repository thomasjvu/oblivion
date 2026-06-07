import { join } from "node:path";
import { createPersistentStore } from "./fileStore.js";
import { MemoryStore } from "./memoryStore.js";

export function createAppStore(): MemoryStore {
  const path = process.env.OBLIVION_STORE_PATH?.trim();
  if (path) return createPersistentStore(path);
  const defaultPath = process.env.OBLIVION_STORE === "file" ? join(process.cwd(), "data", "oblivion.json") : "";
  if (defaultPath) return createPersistentStore(defaultPath);
  return new MemoryStore();
}

export function storePersistPath(): string | null {
  const explicit = process.env.OBLIVION_STORE_PATH?.trim();
  if (explicit) return explicit;
  if (process.env.OBLIVION_STORE === "file") return join(process.cwd(), "data", "oblivion.json");
  return null;
}