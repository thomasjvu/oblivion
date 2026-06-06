import { createHash } from "node:crypto";
import { followUpDate } from "./deadlines.js";
import type {
  ActionRequest,
  AgentPlan,
  AgentPlanStep,
  AutonomyMode,
  BatchApprovalPolicy,
  CaseRecord,
  ConnectorResult,
  FollowUp,
  IdentifierCategory,
  Jurisdiction,
  Preset,
  PresetId,
  VisualNode
} from "./types.js";

export const WORKFLOW_STEPS: AgentPlanStep[] = [
  "collect-minimum-identifiers",
  "verify-trust",
  "discover-candidates",
  "confirm-matches",
  "verify-removal-path",
  "draft-actions",
  "request-approval",
  "execute-approved-action",
  "await-confirmation",
  "schedule-recheck",
  "escalate-if-needed"
];

export const CLEANUP_PRESETS: Preset[] = [
  {
    id: "people-search-cleanup",
    title: "Remove people-search profiles",
    summary: "Find likely people-search profiles, verify matches, draft opt-outs, and schedule recurrence checks.",
    jurisdictions: ["US", "EU", "UK"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["legal-name", "email", "city-state"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Search approved sources", "Submit broker opt-out request", "Recheck profile URL"],
    connectorIds: ["people-search-guidance", "google-removal-plan"],
    expectedWindow: "1-21 days depending on broker response"
  },
  {
    id: "search-result-suppression",
    title: "Suppress search results",
    summary: "Separate source-page deletion from search result suppression and prepare official Google removal paths.",
    jurisdictions: ["US", "EU", "UK"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["legal-name", "email"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Review source URL", "Open official Google removal flow", "Request refresh or suppression"],
    connectorIds: ["google-removal-plan"],
    expectedWindow: "Hours to several days after request review"
  },
  {
    id: "california-drop",
    title: "Use California DROP",
    summary: "Prepare the California resident flow for the official Delete Request and Opt-out Platform.",
    jurisdictions: ["US"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["legal-name", "email", "address"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Confirm California residency", "User-held DROP submission", "Track 90-day broker processing"],
    connectorIds: ["california-drop-guided"],
    expectedWindow: "DROP request now; broker processing timing depends on official schedule"
  },
  {
    id: "gdpr-erasure",
    title: "Send GDPR/UK erasure request",
    summary: "Prepare controller requests, deadline tracking, and escalation notes for EU or UK erasure rights.",
    jurisdictions: ["EU", "UK"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["legal-name", "email"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Disclose identity to controller", "Send erasure request", "Escalate after response window"],
    connectorIds: ["gdpr-template", "google-removal-plan"],
    expectedWindow: "Usually one month, subject to legal exemptions and extensions"
  },
  {
    id: "breach-exposure",
    title: "Check breach exposure",
    summary: "Use mitigation-only breach checks and password range checks without searching breach dumps.",
    jurisdictions: ["US", "EU", "UK"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["email"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["HIBP email check if approved", "Pwned Passwords range check", "Mitigation checklist"],
    connectorIds: ["hibp-email", "hibp-password-range"],
    expectedWindow: "Immediate result for configured checks"
  },
  {
    id: "high-risk-safety",
    title: "High-risk safety cleanup",
    summary: "Prioritize current address, relatives, minors, work or school exposure, and rapid source-page removals.",
    jurisdictions: ["US", "EU", "UK"],
    riskLevel: "high-risk-safety",
    requiredIdentifierCategories: ["legal-name", "address", "relative"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Verify high-risk match locally", "Avoid repeating current address", "Prioritize source removal"],
    connectorIds: ["people-search-guidance", "google-removal-plan", "gdpr-template"],
    expectedWindow: "Triage immediately; response windows vary by source"
  }
];

const NODE_LABELS: Record<AgentPlanStep, { label: string; actor: VisualNode["actor"]; detail: string }> = {
  "select-preset": { label: "Preset", actor: "User", detail: "Choose the cleanup route." },
  "collect-minimum-identifiers": { label: "Vault", actor: "Vault", detail: "Collect only the identifiers this preset needs." },
  "verify-trust": { label: "Trust", actor: "Verifier", detail: "Check runtime and privacy guardrails." },
  "discover-candidates": { label: "Scout", actor: "Scout", detail: "Find candidate exposures from approved sources." },
  "confirm-matches": { label: "Match", actor: "User", detail: "Confirm ambiguous matches before action." },
  "verify-removal-path": { label: "Path", actor: "Verifier", detail: "Use official removal or rights paths." },
  "draft-actions": { label: "Draft", actor: "Draft", detail: "Prepare request text and follow-up timing." },
  "request-approval": { label: "Approve", actor: "User", detail: "Approve exact disclosure before execution." },
  "execute-approved-action": { label: "Submit", actor: "Connector", detail: "Record or execute approved action only." },
  "await-confirmation": { label: "Wait", actor: "Connector", detail: "Track replies and confirmation emails." },
  "schedule-recheck": { label: "Recheck", actor: "Scheduler", detail: "Schedule recurrence checks." },
  "escalate-if-needed": { label: "Escalate", actor: "Scheduler", detail: "Prepare follow-up or escalation if needed." },
  "complete": { label: "Done", actor: "Scheduler", detail: "Current plan cycle is complete." }
};

export function getPreset(presetId: PresetId): Preset {
  const preset = CLEANUP_PRESETS.find((item) => item.id === presetId);
  if (!preset) throw Object.assign(new Error("preset-not-found"), { statusCode: 404 });
  return preset;
}

export function presetAllowedForCase(preset: Preset, caseRecord: CaseRecord): boolean {
  if (!preset.jurisdictions.includes(caseRecord.jurisdiction)) return false;
  if (preset.id === "california-drop" && caseRecord.jurisdiction !== "US") return false;
  return true;
}

export function createAgentPlan(input: {
  caseRecord: CaseRecord;
  presetId: PresetId;
  autonomyMode?: AutonomyMode;
  now?: Date;
}): AgentPlan {
  const preset = getPreset(input.presetId);
  if (!presetAllowedForCase(preset, input.caseRecord)) {
    throw Object.assign(new Error("preset-not-available-for-case"), { statusCode: 422 });
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

export function presetSkipsMatchReview(presetId: PresetId): boolean {
  return (
    presetId === "breach-exposure" ||
    presetId === "search-result-suppression" ||
    presetId === "california-drop" ||
    presetId === "gdpr-erasure"
  );
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

export function createScoutFindings(caseId: string, presetId: PresetId): ConnectorResult {
  const now = new Date().toISOString();
  const highRisk = presetId === "high-risk-safety";
  const connectorId =
    presetId === "breach-exposure"
      ? "hibp-email"
      : presetId === "search-result-suppression"
        ? "google-removal-plan"
        : presetId === "california-drop"
          ? "california-drop-guided"
          : presetId === "gdpr-erasure"
            ? "gdpr-template"
            : "people-search-guidance";
  const officialRemovalPath =
    presetId === "search-result-suppression"
      ? "https://support.google.com/websearch/answer/12719076"
      : presetId === "california-drop"
        ? "https://privacy.ca.gov/drop/"
        : presetId === "gdpr-erasure"
          ? "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/"
          : presetId === "breach-exposure"
            ? "https://haveibeenpwned.com/API/v3"
            : "https://www.consumer.ftc.gov/articles/what-know-about-people-search-sites";
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId,
    status: "ready",
    sourceUrl: officialRemovalPath,
    officialRemovalPath,
    confidence: highRisk ? "medium" : "high",
    requiresUserHandoff: highRisk || presetId === "search-result-suppression",
    nextCheckAt: followUpDate(highRisk ? 3 : 14),
    summary: highRisk
      ? "High-risk scout result from official guidance sources. Confirm match before drafting."
      : "Scout result mapped to official removal guidance for this route.",
    createdAt: now
  };
}

/** @deprecated use createScoutFindings */
export const createMockExposure = createScoutFindings;

export function createGoogleRemovalPlan(caseId: string, sourceUrl?: string): ConnectorResult {
  const now = new Date().toISOString();
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "google-removal-plan",
    status: "planned",
    sourceUrl: sourceUrl || "https://support.google.com/websearch/answer/12719076",
    officialRemovalPath: "https://support.google.com/websearch/answer/12719076",
    confidence: "high",
    requiresUserHandoff: true,
    nextCheckAt: followUpDate(7),
    summary:
      "Google plan separates source-page deletion from search-result suppression. Logged-in submission remains a user handoff.",
    createdAt: now
  };
}

export function createDropPlan(caseRecord: CaseRecord): ConnectorResult {
  const now = new Date().toISOString();
  if (caseRecord.jurisdiction !== "US") {
    throw Object.assign(new Error("drop-california-residency-required"), { statusCode: 422 });
  }
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId: caseRecord.id,
    connectorId: "california-drop-guided",
    status: "planned",
    sourceUrl: "https://privacy.ca.gov/drop/",
    officialRemovalPath: "https://privacy.ca.gov/drop/",
    confidence: "high",
    requiresUserHandoff: true,
    nextCheckAt: followUpDate(90),
    summary:
      "DROP is a California-resident official flow. Oblivion can guide and track it, but the user should complete the government submission.",
    createdAt: now
  };
}

export function createPlanFollowUp(caseId: string, presetId: PresetId): FollowUp {
  return {
    id: `followup_${crypto.randomUUID()}`,
    caseId,
    dueDate: followUpDate(presetId === "california-drop" ? 90 : 14),
    expectedResponseWindow: presetId === "california-drop" ? "Track official 90-day broker processing window." : "Recheck source after expected response window.",
    escalationPath: presetId === "gdpr-erasure" ? "Prepare regulator escalation draft if no lawful response." : "Prepare follow-up request or source recheck."
  };
}

export function pwnedPasswordRangeUrl(hashPrefix: string): string {
  return `https://api.pwnedpasswords.com/range/${hashPrefix.toUpperCase()}`;
}

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}

function createBatchApprovalPolicy(preset: Preset, now: Date): BatchApprovalPolicy {
  return {
    maxDestinations: preset.id === "people-search-cleanup" ? 5 : 3,
    maxActions: preset.id === "high-risk-safety" ? 3 : 8,
    dataCategories: preset.requiredIdentifierCategories.filter((category) => category !== "password"),
    expiresAt: followUpDate(3, now)
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
