import { buildAgentPlanView } from "./cleanup.js";
import { buildHackathonStatus } from "./hackathon.js";
import { buildCaseStatus } from "./status.js";
import type { AgentPlanStep } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export {
  createActionRequest,
  createApproval,
  createBreachExposureApprovals,
  createBrokerOptOutApprovals,
  createContentTakedownApprovals,
  createPresetApproval,
  createPresetApprovals,
  proposeApprovedAction,
  type ProposedActionInput
} from "./approvals.js";

export { buildAgentRunResponse, exposureFromConnector, runCleanupAgentStep } from "./agentRunner.js";

export function buildStatus(store: MemoryStore, caseId: string) {
  const caseRecord = store.getCaseOrThrow(caseId);
  return buildCaseStatus({
    store,
    caseRecord,
    exposures: store.exposuresForCase(caseId),
    approvals: store.approvalsForCase(caseId),
    actions: store.actionsForCase(caseId),
    followUps: store.followUpsForCase(caseId)
  });
}

export function buildHackathonStatusForCase(store: MemoryStore, caseId: string, walletAddress?: string) {
  return buildHackathonStatus({
    caseId,
    permissions: store.permissionGrantsForCase(caseId),
    payments: store.paymentSessionsForCase(caseId),
    veniceAnalyses: store.veniceAnalysesForCase(caseId),
    delegations: store.agentDelegationsForCase(caseId),
    relayerEvents: store.relayerEventsForCase(caseId),
    walletAddress,
    store
  });
}

export function buildAgentNextStep(store: MemoryStore, caseId: string) {
  const plan = store.agentPlanForCase(caseId);
  if (!plan) {
    return {
      action: "select-preset",
      title: "Choose cleanup preset",
      message: "Select a cleanup route so I can build the right agent plan.",
      plan: null
    };
  }
  return {
    action: plan.currentStep,
    title: titleForPlanStep(plan.currentStep),
    message: plan.nextUserDecision,
    blockedReasons: plan.blockedReasons,
    plan: buildAgentPlanView(plan)
  };
}

export function titleForPlanStep(step: AgentPlanStep): string {
  return {
    "select-preset": "Choose cleanup preset",
    "collect-minimum-identifiers": "Collect minimum identifiers",
    "verify-trust": "Verify runtime trust",
    "discover-candidates": "Discover exposure candidates",
    "confirm-matches": "Confirm matches",
    "verify-removal-path": "Verify removal path",
    "draft-actions": "Draft actions",
    "request-approval": "Approval required",
    "execute-approved-action": "Execute approved action",
    "await-confirmation": "Await confirmation",
    "schedule-recheck": "Schedule recheck",
    "escalate-if-needed": "Escalate if needed",
    "complete": "Cleanup cycle complete"
  }[step];
}

