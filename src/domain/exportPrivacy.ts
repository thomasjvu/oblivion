import { publicCaseView } from "./cases.js";
import { buildPartnerCaseStatus } from "./partnerStatus.js";
import { redactText } from "./redaction.js";

import type {
  ActionRequest,
  AgentMessage,
  AgentTimelineEvent,
  Approval,
  CaseRecord,
  VeniceAnalysis
} from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export type ExportAudience = "consumer" | "partner";

export interface ExportFieldPolicy {
  includeEncryptedIntake: boolean;
  includePaymentSessions: boolean;
  includePermissionGrants: boolean;
  includeRelayerEvents: boolean;
  includeVeniceAnalyses: boolean;
  includeAgentDelegations: boolean;
  includeAgentMessages: boolean;
  includeAgentTimeline: boolean;
  includeConnectorResults: boolean;
  includeSourceChecks: boolean;
  includePartnerStatus: boolean;
}

export const EXPORT_PRIVACY_MATRIX: Record<ExportAudience, ExportFieldPolicy> = {
  consumer: {
    includeEncryptedIntake: true,
    includePaymentSessions: true,
    includePermissionGrants: true,
    includeRelayerEvents: true,
    includeVeniceAnalyses: true,
    includeAgentDelegations: true,
    includeAgentMessages: true,
    includeAgentTimeline: true,
    includeConnectorResults: true,
    includeSourceChecks: true,
    includePartnerStatus: false
  },
  partner: {
    includeEncryptedIntake: true,
    includePaymentSessions: false,
    includePermissionGrants: false,
    includeRelayerEvents: false,
    includeVeniceAnalyses: false,
    includeAgentDelegations: false,
    includeAgentMessages: false,
    includeAgentTimeline: false,
    includeConnectorResults: false,
    includeSourceChecks: false,
    includePartnerStatus: true
  }
};

export const DELETE_PRIVACY_GUARANTEES = {
  clearsEncryptedIntake: true,
  clearsVaultPointer: true,
  purgesApprovals: true,
  purgesActions: true,
  purgesExposures: true,
  purgesTimeline: true,
  retainsTombstone: true,
  retainsPartnerAuditTrail: true,
  neverReturnsAccessToken: true
} as const;

export function redactedApprovalForExport(approval: Approval) {
  return {
    id: approval.id,
    caseId: approval.caseId,
    actionType: approval.actionType,
    destination: approval.destination,
    identifiersApproved: approval.identifiersApproved,
    dataToDisclose: approval.dataToDisclose,
    purpose: approval.purpose,
    disclosureRisk: approval.disclosureRisk,
    status: approval.status,
    expiresAt: approval.expiresAt,
    createdAt: approval.createdAt,
    approvedAt: approval.approvedAt,
    userConfirmationProvided: Boolean(approval.userConfirmation)
  };
}

export function redactedActionForExport(action: ActionRequest) {
  return {
    ...action,
    draftText: redactText(action.draftText),
    executionRecord: action.executionRecord ? redactText(action.executionRecord) : undefined
  };
}

export function redactedAgentMessageForExport(message: AgentMessage) {
  return {
    ...message,
    redactedPayload: redactText(message.redactedPayload)
  };
}

export function redactedTimelineForExport(event: AgentTimelineEvent) {
  return {
    ...event,
    summary: redactText(event.summary)
  };
}

export function redactedVeniceAnalysisForExport(analysis: VeniceAnalysis) {
  return {
    ...analysis,
    output: {
      ...analysis.output,
      summary: redactText(analysis.output.summary),
      draftText: analysis.output.draftText ? redactText(analysis.output.draftText) : undefined
    }
  };
}

export function buildCaseExportBundle(
  store: MemoryStore,
  caseRecord: CaseRecord,
  audience: ExportAudience
) {
  const policy = EXPORT_PRIVACY_MATRIX[audience];
  const caseView =
    audience === "partner"
      ? {
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
          encryptedIntake: policy.includeEncryptedIntake ? caseRecord.encryptedIntake ?? null : null
        }
      : publicCaseView(caseRecord);

  const bundle: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    audience,
    case: caseView,
    approvals: store.approvalsForCase(caseRecord.id).map(redactedApprovalForExport),
    actions: store.actionsForCase(caseRecord.id).map(redactedActionForExport),
    exposures: store.exposuresForCase(caseRecord.id),
    followUps: store.followUpsForCase(caseRecord.id),
    agentPlan: store.agentPlanForCase(caseRecord.id) ?? null
  };

  if (policy.includeSourceChecks) {
    bundle.sourceChecks = [...store.sourceChecks.values()].filter((item) => item.caseId === caseRecord.id);
  }
  if (policy.includePaymentSessions) bundle.paymentSessions = store.paymentSessionsForCase(caseRecord.id);
  if (policy.includePermissionGrants) bundle.permissionGrants = store.permissionGrantsForCase(caseRecord.id);
  if (policy.includeRelayerEvents) bundle.relayerEvents = store.relayerEventsForCase(caseRecord.id);
  if (policy.includeVeniceAnalyses) {
    bundle.veniceAnalyses = store.veniceAnalysesForCase(caseRecord.id).map(redactedVeniceAnalysisForExport);
  }
  if (policy.includeAgentDelegations) bundle.agentDelegations = store.agentDelegationsForCase(caseRecord.id);
  if (policy.includeAgentMessages) {
    bundle.agentMessages = store.agentMessagesForCase(caseRecord.id).map(redactedAgentMessageForExport);
  }
  if (policy.includeAgentTimeline) {
    bundle.agentTimeline = store.agentTimelineForCase(caseRecord.id).map(redactedTimelineForExport);
  }
  if (policy.includeConnectorResults) bundle.connectorResults = store.connectorResultsForCase(caseRecord.id);
  if (policy.includePartnerStatus) bundle.partnerStatus = buildPartnerCaseStatus(store, caseRecord.id);

  return bundle;
}

export function assertExportBundleHasNoSecrets(serialized: string): string[] {
  const violations: string[] = [];
  if (/accessTokenHash/i.test(serialized)) violations.push("access-token-hash-leaked");
  if (/"userConfirmation"\s*:/.test(serialized)) violations.push("user-confirmation-text-leaked");
  return violations;
}