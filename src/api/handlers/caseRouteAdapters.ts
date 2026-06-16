import type { IncomingMessage } from "node:http";
import type { CaseRecord, PartnerRecord } from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { HttpError } from "../errors.js";
import { assertPartnerOwnsCase, getCaseWithAccess } from "../auth.js";
import { buildStatus } from "../../domain/status.js";
import { buildPartnerCaseStatus } from "../../domain/partnerStatus.js";
import { assertCaseActivated } from "../../domain/caseActivation.js";

export async function withConsumerCase<T extends Record<string, unknown>>(
  request: IncomingMessage,
  store: MemoryStore,
  caseId: string,
  fn: (caseRecord: CaseRecord) => T | Promise<T>
): Promise<T & { status: ReturnType<typeof buildStatus> }> {
  const caseRecord = getCaseWithAccess(request, store, caseId);
  const result = await fn(caseRecord);
  return { ...result, status: buildStatus(store, caseId) };
}

export async function withActivatedConsumerCase<T extends Record<string, unknown>>(
  request: IncomingMessage,
  store: MemoryStore,
  caseId: string,
  fn: (caseRecord: CaseRecord) => T | Promise<T>
): Promise<T & { status: ReturnType<typeof buildStatus> }> {
  return withConsumerCase(request, store, caseId, async (caseRecord) => {
    assertCaseActivated(store, caseRecord);
    return fn(caseRecord);
  });
}

export async function withPartnerCase<T extends Record<string, unknown>>(
  partner: PartnerRecord,
  store: MemoryStore,
  caseId: string,
  fn: (caseRecord: CaseRecord) => T | Promise<T>
): Promise<T & { partnerStatus: ReturnType<typeof buildPartnerCaseStatus> }> {
  const caseRecord = store.getCaseOrThrow(caseId);
  assertPartnerOwnsCase(partner, caseRecord);
  const result = await fn(caseRecord);
  return { ...result, partnerStatus: buildPartnerCaseStatus(store, caseId) };
}

export function resolveConsumerCaseForApproval(
  request: IncomingMessage,
  store: MemoryStore,
  approvalId: string
): CaseRecord {
  const approval = store.approvals.get(approvalId);
  if (!approval) throw new HttpError(404, "approval-not-found");
  const caseRecord = getCaseWithAccess(request, store, approval.caseId);
  assertCaseActivated(store, caseRecord);
  return caseRecord;
}

export function resolveConsumerCaseForAction(
  request: IncomingMessage,
  store: MemoryStore,
  actionId: string
): CaseRecord {
  const action = store.actions.get(actionId);
  if (!action) throw new HttpError(404, "action-not-found");
  const caseRecord = getCaseWithAccess(request, store, action.caseId);
  assertCaseActivated(store, caseRecord);
  return caseRecord;
}