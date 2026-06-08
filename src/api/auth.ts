import type { IncomingMessage } from "node:http";
import { partnerFromAuthorization } from "../domain/partners.js";
import type { CaseRecord, PartnerRecord } from "../domain/types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { HttpError } from "./errors.js";

export function resolvePartnerAuth(
  request: IncomingMessage,
  store: MemoryStore
): PartnerRecord | undefined {
  return partnerFromAuthorization(request.headers.authorization, store.partners);
}

export function requirePartnerAuth(request: IncomingMessage, store: MemoryStore): PartnerRecord {
  const partner = resolvePartnerAuth(request, store);
  if (!partner) throw new HttpError(401, "partner-api-key-required");
  return partner;
}

export function assertPartnerOwnsCase(partner: PartnerRecord, caseRecord: CaseRecord): void {
  if (caseRecord.partnerId !== partner.id) {
    throw new HttpError(403, "case-not-owned-by-partner");
  }
}

export function assertCaseExportAllowed(
  request: IncomingMessage,
  store: MemoryStore,
  caseRecord: CaseRecord
): void {
  if (!caseRecord.partnerId) return;
  const partner = requirePartnerAuth(request, store);
  assertPartnerOwnsCase(partner, caseRecord);
}