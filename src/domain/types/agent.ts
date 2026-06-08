import type { ActionType, IdentifierCategory, Jurisdiction, RiskLevel } from "./case.js";

export type PresetId =
  | "people-search-cleanup"
  | "search-result-suppression"
  | "california-drop"
  | "gdpr-erasure"
  | "breach-exposure"
  | "high-risk-safety"
  | "content-takedown";

export type AutonomyMode = "approval-gated" | "high-autonomy";

export type AgentPlanStep =
  | "select-preset"
  | "collect-minimum-identifiers"
  | "verify-trust"
  | "discover-candidates"
  | "confirm-matches"
  | "verify-removal-path"
  | "draft-actions"
  | "request-approval"
  | "execute-approved-action"
  | "await-confirmation"
  | "schedule-recheck"
  | "escalate-if-needed"
  | "complete";

export interface Preset {
  id: PresetId;
  title: string;
  summary: string;
  jurisdictions: Jurisdiction[];
  riskLevel: RiskLevel;
  requiredIdentifierCategories: IdentifierCategory[];
  defaultAutonomy: AutonomyMode;
  steps: AgentPlanStep[];
  disclosurePoints: string[];
  connectorIds: string[];
  expectedWindow: string;
  skipsMatchReview?: boolean;
  defaultActionType?: ActionType;
  defaultDestination?: string;
  discoveryMode?: "broker" | "content" | "official-path";
}

export interface VisualNode {
  id: AgentPlanStep;
  label: string;
  actor: "Vault" | "Scout" | "Verifier" | "Draft" | "User" | "Connector" | "Scheduler";
  status: "pending" | "active" | "blocked" | "done";
  detail: string;
}

export interface BatchApprovalPolicy {
  maxDestinations: number;
  maxActions: number;
  dataCategories: IdentifierCategory[];
  expiresAt: string;
}

export interface AgentPlan {
  id: string;
  caseId: string;
  presetId: PresetId;
  autonomyMode: AutonomyMode;
  currentStep: AgentPlanStep;
  visualNodes: VisualNode[];
  pendingApprovals: string[];
  blockedReasons: string[];
  nextUserDecision: string;
  batchApprovalPolicy?: BatchApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export type VeniceAnalysisKind = "classify-case" | "draft-request" | "review-approval";

export interface VeniceAnalysis {
  id: string;
  caseId: string;
  kind: VeniceAnalysisKind;
  model: string;
  redactedInputSummary: string;
  output: {
    title: string;
    summary: string;
    risk?: RiskLevel;
    recommendedTask?: ActionType;
    draftText?: string;
    approvalExplanation?: string;
    nextSteps: string[];
  };
  createdAt: string;
}

export type AgentName = "OblivionRoot" | "ScoutAgent" | "DraftAgent" | "VerifierAgent" | "PaymentAgent" | "SchedulerAgent";

export interface AgentDelegation {
  id: string;
  caseId: string;
  fromAgent: AgentName;
  toAgent: AgentName;
  scope: string[];
  dataCategories: IdentifierCategory[];
  permissionGrantId: string;
  expiresAt: string;
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  caseId: string;
  fromAgent: AgentName;
  toAgent: AgentName;
  purpose: string;
  redactedPayload: string;
  createdAt: string;
}

export interface AgentTimelineEvent {
  id: string;
  caseId: string;
  title: string;
  actor: AgentName | "MetaMask" | "1Shot" | "Venice" | "x402" | "Google" | "HIBP" | "DROP";
  summary: string;
  createdAt: string;
}

export interface HackathonStatus {
  caseId: string;
  smartAccountVisible: boolean;
  erc7715PermissionGranted: boolean;
  x402OneOffReady: boolean;
  erc7710SubscriptionReady: boolean;
  veniceOutputReady: boolean;
  a2aRedelegationVisible: boolean;
  oneShotRelayerVisible: boolean;
}