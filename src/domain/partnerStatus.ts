import type { MemoryStore } from "../storage/memoryStore.js";
import { buildStatus } from "./status.js";
import type { AgentPlanStep } from "./types.js";

export interface PartnerCaseStatusView {
  caseId: string;
  partnerId?: string;
  externalRef?: string;
  phase: AgentPlanStep | "intake" | "unknown";
  pendingApprovals: number;
  confirmedExposures: number;
  removalsComplete: number;
  removalsPending: number;
  nextRecheck?: string;
  blockedReasons: string[];
}

export interface PartnerRiskSummary {
  caseId: string;
  exposureCount: number;
  confirmedListingCount: number;
  pendingApprovalCount: number;
  submittedActionCount: number;
  recheckOverdue: boolean;
  breachChecksRequested: boolean;
}

export function buildPartnerCaseStatus(store: MemoryStore, caseId: string): PartnerCaseStatusView {
  const caseRecord = store.getCaseOrThrow(caseId);
  const status = buildStatus(store, caseId);
  const plan = store.agentPlanForCase(caseId);
  const followUps = store.followUpsForCase(caseId).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    caseId,
    partnerId: caseRecord.partnerId,
    externalRef: caseRecord.externalRef,
    phase: plan?.currentStep ?? (caseRecord.encryptedIntake ? "intake" : "unknown"),
    pendingApprovals: status.approvalsNeeded.length,
    confirmedExposures: status.confirmedFindings.length,
    removalsComplete: status.submittedActions.length,
    removalsPending: status.actionsReady.length,
    nextRecheck: followUps[0]?.dueDate,
    blockedReasons: plan?.blockedReasons ?? []
  };
}

export function buildPartnerRiskSummary(store: MemoryStore, caseId: string): PartnerRiskSummary {
  const status = buildStatus(store, caseId);
  const actions = store.actionsForCase(caseId);
  const now = Date.now();
  const followUps = store.followUpsForCase(caseId);
  const recheckOverdue = followUps.some((followUp) => new Date(followUp.dueDate).getTime() < now);
  return {
    caseId,
    exposureCount: status.findings.length,
    confirmedListingCount: status.confirmedFindings.length,
    pendingApprovalCount: status.approvalsNeeded.length,
    submittedActionCount: status.submittedActions.length,
    recheckOverdue,
    breachChecksRequested: actions.some((action) => action.actionType === "hibp-email-check")
  };
}