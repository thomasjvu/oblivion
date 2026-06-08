import type { IncomingMessage } from "node:http";
import { verifyCaseAccessToken } from "../domain/caseAccess.js";
import { partnerFromAuthorization } from "../domain/partners.js";
import type { CaseRecord, PartnerRecord } from "../domain/types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { HttpError } from "./errors.js";

export function extractBearerToken(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return undefined;
  const token = auth.slice(7).trim();
  return token || undefined;
}

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

export function assertConsumerCaseRoute(caseRecord: CaseRecord): void {
  if (caseRecord.partnerId) {
    throw new HttpError(403, "partner-case-use-v1-api");
  }
}

export function requireCaseAccess(request: IncomingMessage, caseRecord: CaseRecord): void {
  assertConsumerCaseRoute(caseRecord);
  const token = extractBearerToken(request);
  if (!token || !verifyCaseAccessToken(token, caseRecord.accessTokenHash)) {
    throw new HttpError(401, "case-access-token-required");
  }
}

export function getCaseWithAccess(
  request: IncomingMessage,
  store: MemoryStore,
  caseId: string
): CaseRecord {
  const caseRecord = store.getCaseOrThrow(caseId);
  requireCaseAccess(request, caseRecord);
  return caseRecord;
}

export function assertCaseExportAllowed(
  request: IncomingMessage,
  store: MemoryStore,
  caseRecord: CaseRecord
): void {
  if (caseRecord.partnerId) {
    const partner = requirePartnerAuth(request, store);
    assertPartnerOwnsCase(partner, caseRecord);
    return;
  }
  requireCaseAccess(request, caseRecord);
}