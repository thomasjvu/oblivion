import { DomainError } from "../errors.js";
import { followUpDate } from "../deadlines.js";
import type {
  ActionType,
  AgentPlanStep,
  BatchApprovalPolicy,
  CaseRecord,
  Jurisdiction,
  Preset,
  PresetId,
  VisualNode
} from "../types.js";

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
    disclosurePoints: ["Sweep data-broker catalog", "Submit per-broker opt-out", "Recheck each listing"],
    connectorIds: ["broker-registry-sweep", "people-search-guidance", "broker-opt-out-live", "california-drop-guided"],
    expectedWindow: "1-21 days depending on broker response",
    discoveryMode: "broker",
    defaultActionType: "broker-opt-out",
    defaultDestination: "Confirmed people-search broker"
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
    expectedWindow: "Hours to several days after request review",
    skipsMatchReview: true,
    discoveryMode: "official-path",
    defaultActionType: "search-result-removal",
    defaultDestination: "Google Search removal flow"
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
    expectedWindow: "DROP request now; broker processing timing depends on official schedule",
    skipsMatchReview: true,
    discoveryMode: "official-path",
    defaultActionType: "gdpr-erasure",
    defaultDestination: "California DROP"
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
    expectedWindow: "Usually one month, subject to legal exemptions and extensions",
    skipsMatchReview: true,
    discoveryMode: "official-path",
    defaultActionType: "gdpr-erasure",
    defaultDestination: "Named data controller"
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
    expectedWindow: "Immediate result for configured checks",
    skipsMatchReview: true,
    discoveryMode: "official-path",
    defaultActionType: "hibp-email-check",
    defaultDestination: "Have I Been Pwned"
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
    connectorIds: ["broker-registry-sweep", "people-search-guidance", "broker-opt-out-live", "google-removal-plan", "gdpr-template"],
    expectedWindow: "Triage immediately; response windows vary by source",
    discoveryMode: "broker",
    defaultActionType: "broker-opt-out",
    defaultDestination: "Confirmed high-risk exposure source"
  },
  {
    id: "content-takedown",
    title: "Takedown copied content",
    summary: "Identify infringing URLs, draft DMCA or platform abuse notices, and pause for approval before any host contact.",
    jurisdictions: ["US", "EU", "UK"],
    riskLevel: "standard",
    requiredIdentifierCategories: ["legal-name", "email", "infringing-url", "original-work-ref"],
    defaultAutonomy: "approval-gated",
    steps: WORKFLOW_STEPS,
    disclosurePoints: ["Confirm infringing URL", "Draft takedown notice", "Disclose contact to host or platform"],
    connectorIds: ["dmca-notice-drafter", "platform-abuse-handoff", "platform-abuse-live"],
    expectedWindow: "Hours to several weeks depending on host response",
    discoveryMode: "content",
    defaultActionType: "dmca-takedown",
    defaultDestination: "Infringing host abuse contact"
  }
];

export const NODE_LABELS: Record<AgentPlanStep, { label: string; actor: VisualNode["actor"]; detail: string }> = {
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
  if (!preset) throw new DomainError("preset-not-found", 404);
  return preset;
}

export function presetAllowedForCase(preset: Preset, caseRecord: CaseRecord): boolean {
  if (!preset.jurisdictions.includes(caseRecord.jurisdiction)) return false;
  if (preset.id === "california-drop" && caseRecord.jurisdiction !== "US") return false;
  return true;
}

export function presetSkipsMatchReview(presetId: PresetId): boolean {
  return getPreset(presetId).skipsMatchReview === true;
}

export function presetUsesOfficialPathDiscovery(presetId: PresetId): boolean {
  return getPreset(presetId).discoveryMode === "official-path";
}

export function defaultActionTypeForPreset(presetId: PresetId, jurisdiction: Jurisdiction): ActionType {
  const preset = getPreset(presetId);
  if (preset.defaultActionType) {
    if (presetId === "gdpr-erasure" && jurisdiction === "UK") return "uk-gdpr-erasure";
    return preset.defaultActionType;
  }
  return "broker-opt-out";
}

export function defaultDestinationForPreset(presetId: PresetId): string {
  return getPreset(presetId).defaultDestination ?? "Confirmed people-search broker";
}

export function presetUsesBrokerDiscovery(presetId: PresetId): boolean {
  return presetId === "people-search-cleanup" || presetId === "high-risk-safety";
}

export function presetUsesContentDiscovery(presetId: PresetId): boolean {
  return presetId === "content-takedown";
}

export function createBatchApprovalPolicy(preset: Preset, now: Date): BatchApprovalPolicy {
  return {
    maxDestinations:
      preset.id === "people-search-cleanup" ? 25 : preset.id === "high-risk-safety" ? 10 : preset.id === "content-takedown" ? 5 : 3,
    maxActions:
      preset.id === "people-search-cleanup" ? 25 : preset.id === "high-risk-safety" ? 10 : preset.id === "content-takedown" ? 10 : 8,
    dataCategories: preset.requiredIdentifierCategories.filter((category) => category !== "password"),
    expiresAt: followUpDate(3, now)
  };
}