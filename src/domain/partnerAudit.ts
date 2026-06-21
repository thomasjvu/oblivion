import { buildCaseExportBundle } from "./exportPrivacy.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { CaseRecord, PartnerDataAccessAction, PartnerDataAccessEvent } from "./types.js";

export function recordPartnerDataAccess(
  store: MemoryStore,
  input: {
    partnerId: string;
    caseId: string;
    action: PartnerDataAccessAction;
    source: "v1" | "api";
  }
): PartnerDataAccessEvent {
  const event: PartnerDataAccessEvent = {
    id: `audit_${crypto.randomUUID()}`,
    partnerId: input.partnerId,
    caseId: input.caseId,
    action: input.action,
    source: input.source,
    at: new Date().toISOString()
  };
  store.partnerDataAccess.set(event.id, event);
  store.markDirty();
  return event;
}

export function listPartnerDataAccess(
  store: MemoryStore,
  partnerId: string,
  options: { caseId?: string; limit?: number } = {}
) {
  const limit = options.limit ?? 50;
  return [...store.partnerDataAccess.values()]
    .filter((event) => event.partnerId === partnerId)
    .filter((event) => (options.caseId ? event.caseId === options.caseId : true))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export function buildPartnerCaseExport(store: MemoryStore, caseRecord: CaseRecord) {
  return buildCaseExportBundle(store, caseRecord, "partner");
}