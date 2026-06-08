import { parsePartnerKeysFromEnv, parseSandboxPartnerKeysFromEnv } from "./partners.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export function seedPartnersFromEnv(store: MemoryStore): void {
  if (store.partners.size > 0) return;
  try {
    for (const partner of [...parsePartnerKeysFromEnv(), ...parseSandboxPartnerKeysFromEnv()]) {
      store.partners.set(partner.id, partner);
    }
  } catch {
    // ignore invalid env during local dev
  }
}