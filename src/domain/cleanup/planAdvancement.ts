import { DomainError } from "../errors.js";
import {
  createBatchApprovalPolicy,
  getPreset,
  NODE_LABELS,
  presetAllowedForCase,
  presetSkipsMatchReview,
  WORKFLOW_STEPS
} from "./presets.js";
import type { AgentPlan, AgentPlanStep, AutonomyMode, CaseRecord, PresetId, VisualNode } from "../types.js";

export function createAgentPlan(input: {
  caseRecord: CaseRecord;
  presetId: PresetId;
  autonomyMode?: AutonomyMode;
  now?: Date;
}): AgentPlan {
  const preset = getPreset(input.presetId);
  if (!presetAllowedForCase(preset, input.caseRecord)) {
    throw new DomainError("preset-not-available-for-case", 422);
  }
  const now = input.now ?? new Date();
  const autonomyMode = input.autonomyMode ?? preset.defaultAutonomy;
  return {
    id: `plan_${crypto.randomUUID()}`,
    caseId: input.caseRecord.id,
    presetId: preset.id,
    autonomyMode,
    currentStep: "collect-minimum-identifiers",
    visualNodes: buildVisualNodes("collect-minimum-identifiers", []),
    pendingApprovals: [],
    blockedReasons: [],
    nextUserDecision: "Confirm the minimum identifiers for this preset.",
    batchApprovalPolicy: autonomyMode === "high-autonomy" ? createBatchApprovalPolicy(preset, now) : undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

export function advanceAgentPlan(input: {
  plan: AgentPlan;
  caseRecord: CaseRecord;
  findingsCount: number;
  pendingFindingsCount: number;
  approvalsPending: number;
  actionsReady: number;
  submittedActions: number;
  trustPass: boolean;
  now?: Date;
}): AgentPlan {
  const now = input.now ?? new Date();
  const blockedReasons: string[] = [];
  let currentStep = input.plan.currentStep;
  let nextUserDecision = "";

  if (currentStep === "collect-minimum-identifiers") {
    if (!input.caseRecord.redactedScope?.personLabel) {
      blockedReasons.push("minimum-identifiers-needed");
      nextUserDecision = "Add a case label and the preset's minimum identifiers to the encrypted vault.";
    } else {
      currentStep = "verify-trust";
      nextUserDecision = "Review runtime status before discovery uses managed execution.";
    }
  } else if (currentStep === "verify-trust") {
    currentStep = "discover-candidates";
    nextUserDecision = input.trustPass
      ? "Trust checks are passing. The agent can scan approved sources."
      : "Local mode is available; sensitive managed execution remains blocked until TEE status passes.";
  } else if (currentStep === "discover-candidates") {
    if (input.findingsCount + input.pendingFindingsCount === 0) {
      if (presetSkipsMatchReview(input.plan.presetId)) {
        currentStep = "verify-removal-path";
        nextUserDecision = "Verify the official removal or rights path for this preset.";
      } else {
        blockedReasons.push("discovery-needed");
        nextUserDecision = "Run discovery or paste known profile URLs before confirming matches.";
      }
    } else {
      currentStep = "confirm-matches";
      nextUserDecision = "Review each link — confirm yours or mark Not me.";
    }
  } else if (currentStep === "confirm-matches") {
    if (input.pendingFindingsCount > 0) {
      blockedReasons.push("candidate-confirmation-needed");
      nextUserDecision = "Confirm or reject every pending link before removal drafting.";
    } else if (input.findingsCount === 0) {
      blockedReasons.push("no-confirmed-matches");
      nextUserDecision = "Confirm at least one exposure or paste additional URLs to search again.";
    } else {
      currentStep = "verify-removal-path";
      nextUserDecision = "Verify official removal paths for confirmed matches.";
    }
  } else if (currentStep === "verify-removal-path") {
    currentStep = "draft-actions";
    nextUserDecision = "Draft the removal or suppression packet.";
  } else if (currentStep === "draft-actions") {
    currentStep = "request-approval";
    nextUserDecision = "Review the exact data that would be disclosed.";
  } else if (currentStep === "request-approval") {
    if (input.approvalsPending > 0) {
      blockedReasons.push("approval-required");
      nextUserDecision = "Approve or reject the pending disclosure card.";
    } else if (input.actionsReady > 0) {
      currentStep = "execute-approved-action";
      nextUserDecision = "Execute or record the approved action.";
    } else {
      blockedReasons.push("approval-card-needed");
      nextUserDecision = "Create the approval card for the current preset.";
    }
  } else if (currentStep === "execute-approved-action") {
    if (input.actionsReady > 0) {
      blockedReasons.push("approved-action-ready");
      nextUserDecision = "Record or execute the approved action.";
    } else if (input.submittedActions > 0) {
      currentStep = "await-confirmation";
      nextUserDecision = "Wait for broker or service confirmation.";
    } else {
      blockedReasons.push("approved-action-needed");
      nextUserDecision = "Approve an action before execution.";
    }
  } else if (currentStep === "await-confirmation") {
    currentStep = "schedule-recheck";
    nextUserDecision = "Schedule the recheck window.";
  } else if (currentStep === "schedule-recheck") {
    currentStep = "escalate-if-needed";
    nextUserDecision = "Prepare follow-up if the source does not respond.";
  } else if (currentStep === "escalate-if-needed") {
    currentStep = "complete";
    nextUserDecision = "This cycle is complete. Recheck later for recurrence.";
  } else {
    currentStep = "complete";
    nextUserDecision = "This cycle is complete. Recheck later for recurrence.";
  }

  return {
    ...input.plan,
    currentStep,
    blockedReasons,
    nextUserDecision,
    visualNodes: buildVisualNodes(currentStep, blockedReasons),
    updatedAt: now.toISOString()
  };
}

export function buildAgentPlanView(plan: AgentPlan): AgentPlan {
  return {
    ...plan,
    visualNodes: buildVisualNodes(plan.currentStep, plan.blockedReasons)
  };
}

function buildVisualNodes(currentStep: AgentPlanStep, blockedReasons: string[]): VisualNode[] {
  const currentIndex = WORKFLOW_STEPS.indexOf(currentStep);
  return WORKFLOW_STEPS.map((step, index) => {
    const spec = NODE_LABELS[step];
    const isActive = step === currentStep;
    const isBlocked = isActive && blockedReasons.length > 0;
    return {
      id: step,
      label: spec.label,
      actor: spec.actor,
      status: isBlocked ? "blocked" : isActive ? "active" : index < currentIndex || currentStep === "complete" ? "done" : "pending",
      detail: spec.detail
    };
  });
}