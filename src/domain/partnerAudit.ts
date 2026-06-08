import type { MemoryStore } from "../storage/memoryStore.js";
import { buildPartnerCaseStatus } from "./partnerStatus.js";
import type {
  Approval,
  CaseRecord,
  PartnerDataAccessAction,
  PartnerDataAccessEvent
} from "./types.js";

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

function redactedApprovalView(approval: Approval) {
  return {
    id: approval.id,
    caseId: approval.caseId,
    actionType: approval.actionType,
    destination: approval.destination,
    dataToDisclose: approval.dataToDisclose,
    status: approval.status,
    expiresAt: approval.expiresAt,
    approvedAt: approval.approvedAt,
    userConfirmationProvided: Boolean(approval.userConfirmation)
  };
}

export function buildPartnerCaseExport(store: MemoryStore, caseRecord: CaseRecord) {
  return {
    exportedAt: new Date().toISOString(),
    case: {
      id: caseRecord.id,
      jurisdiction: caseRecord.jurisdiction,
      riskLevel: caseRecord.riskLevel,
      authorityBasis: caseRecord.authorityBasis,
      partnerId: caseRecord.partnerId,
      externalRef: caseRecord.externalRef,
      retentionDays: caseRecord.retentionDays,
      createdAt: caseRecord.createdAt,
      updatedAt: caseRecord.updatedAt,
      redactedScope: caseRecord.redactedScope ?? null,
      encryptedIntake: caseRecord.encryptedIntake ?? null
    },
    approvals: store.approvalsForCase(caseRecord.id).map(redactedApprovalView),
    actions: store.actionsForCase(caseRecord.id),
    exposures: store.exposuresForCase(caseRecord.id),
    followUps: store.followUpsForCase(caseRecord.id),
    agentPlan: store.agentPlanForCase(caseRecord.id) ?? null,
    partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
  };
}