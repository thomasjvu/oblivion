export type Jurisdiction = "US" | "EU" | "UK";

export type RiskLevel = "standard" | "high-risk-safety";

export type AuthorityBasis =
  | "self"
  | "authorized-representative"
  | "minor-guardian"
  | "estate"
  | "survivor"
  | "employee"
  | "tenant";

export type IdentifierCategory =
  | "legal-name"
  | "alias"
  | "email"
  | "phone"
  | "address"
  | "city-state"
  | "date-of-birth"
  | "relative"
  | "workplace"
  | "school"
  | "government-id"
  | "ssn"
  | "password"
  | "payment"
  | "unknown";

export type ActionType =
  | "people-search-discovery"
  | "broker-opt-out"
  | "search-result-removal"
  | "gdpr-erasure"
  | "uk-gdpr-erasure"
  | "hibp-email-check"
  | "pwned-password-range-check"
  | "follow-up"
  | "escalation-draft";

export type ApprovalStatus = "pending" | "approved" | "expired" | "revoked" | "used";

export type ExecutionStatus =
  | "draft"
  | "awaiting-approval"
  | "ready"
  | "recorded"
  | "blocked"
  | "failed";

export interface EncryptedBlob {
  alg: "AES-256-GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  aad?: string;
}

export interface CaseRecord {
  id: string;
  jurisdiction: Jurisdiction;
  riskLevel: RiskLevel;
  authorityBasis: AuthorityBasis;
  encryptedVaultPointer: string;
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  redactedScope?: RedactedScope;
  encryptedIntake?: EncryptedBlob;
}

export interface RedactedScope {
  personLabel: string;
  aliases: string[];
  approvedIdentifierLabels: string[];
  sensitiveConstraints: string[];
}

export interface Identifier {
  id: string;
  category: IdentifierCategory;
  redactedDisplay: string;
  approvalEligible: boolean;
  encryptedValue?: EncryptedBlob;
}

export type ExposureMatchStatus = "pending" | "confirmed" | "rejected";
export type ExposureMatchScore = "likely" | "uncertain" | "unlikely";
export type ExposureRemovalStatus =
  | "not-started"
  | "drafted"
  | "submitted"
  | "awaiting-response"
  | "removed"
  | "failed";

export interface Exposure {
  id: string;
  caseId: string;
  sourceUrl: string;
  visibleDataCategories: IdentifierCategory[];
  confidence: "low" | "medium" | "high";
  evidencePointer?: string;
  officialRemovalPath?: string;
  createdAt: string;
  matchStatus?: ExposureMatchStatus;
  brokerId?: string;
  brokerLabel?: string;
  redactedSnippet?: string;
  matchScore?: ExposureMatchScore;
  matchReason?: string;
  removalStatus?: ExposureRemovalStatus;
  officialOptOutUrl?: string;
}

export interface Approval {
  id: string;
  caseId: string;
  actionType: ActionType;
  destination: string;
  identifiersApproved: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  purpose: string;
  disclosureRisk: string;
  expiresAt: string;
  status: ApprovalStatus;
  createdAt: string;
  approvedAt?: string;
  userConfirmation?: string;
}

export interface ActionRequest {
  id: string;
  caseId: string;
  actionType: ActionType;
  destination: string;
  template: string;
  draftText: string;
  deadlineBasis?: string;
  expectedConfirmationStep: string;
  approvalId: string;
  executionStatus: ExecutionStatus;
  createdAt: string;
  executedAt?: string;
  executionRecord?: string;
}

export interface SourceCheck {
  id: string;
  caseId: string;
  officialUrl: string;
  checkedAt: string;
  claimVerified: string;
  operatorVersion: string;
}

export interface FollowUp {
  id: string;
  caseId: string;
  dueDate: string;
  expectedResponseWindow: string;
  escalationPath: string;
}

export type PresetId =
  | "people-search-cleanup"
  | "search-result-suppression"
  | "california-drop"
  | "gdpr-erasure"
  | "breach-exposure"
  | "high-risk-safety";

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

export type ConnectorStatus = "planned" | "blocked" | "ready" | "submitted" | "recorded" | "failed";

export interface ConnectorResult {
  id: string;
  caseId: string;
  connectorId: string;
  status: ConnectorStatus;
  sourceUrl: string;
  officialRemovalPath?: string;
  confidence: "low" | "medium" | "high";
  requiresUserHandoff: boolean;
  nextCheckAt?: string;
  summary: string;
  createdAt: string;
}

export interface AttestationProof {
  deploymentVersion: string;
  sourceCommit: string;
  expectedComposeHash: string;
  imageDigests: string[];
  attestationReport: unknown;
  verificationInstructions: string[];
  verifierResult: "not-configured" | "pass" | "fail";
  checkedAt: string;
  attestationFresh: boolean;
  composeHashMatches: boolean;
  imageDigestsPinned: boolean;
  hardwareQuoteVerified: boolean | null;
  trustSummary: string;
  verificationErrors: string[];
}

export interface CaseStatus {
  scope: RedactedScope | null;
  findings: Exposure[];
  pendingFindings: Exposure[];
  confirmedFindings: Exposure[];
  approvalsNeeded: Approval[];
  actionsReady: ActionRequest[];
  submittedActions: ActionRequest[];
  nextChecks: FollowUp[];
}

export type PaymentMode = "one-off" | "subscription";
export type PaymentStatus = "payment-required" | "authorized" | "paid" | "failed";

export interface PaymentProduct {
  id: string;
  name: string;
  mode: PaymentMode;
  description: string;
  amountUsd: number;
  token: "USDC";
  network: "base" | "ethereum";
  cadence?: "weekly" | "monthly";
  x402Endpoint: string;
  requiredPermission: "erc7710-payment";
}

export interface X402PaymentRequest {
  version: "x402-demo-v1" | "x402-v2";
  endpoint: string;
  amountUsd: number;
  token: string;
  network: string;
  memo: string;
  expiresAt: string;
}

export interface Erc7710Delegation {
  standard: "ERC-7710";
  delegate: string;
  endpoint: string;
  spendCapUsd: number;
  token: string;
  cadence?: "weekly" | "monthly";
  expiresAt: string;
  scope: string[];
}

export interface PaymentSession {
  id: string;
  caseId: string;
  productId: string;
  mode: PaymentMode;
  status: PaymentStatus;
  amountUsd: number;
  token: string;
  network: string;
  cadence?: "weekly" | "monthly";
  x402Request: X402PaymentRequest;
  erc7710Delegation: Erc7710Delegation;
  walletAddress?: string;
  smartAccountAddress?: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionType =
  | "eip7702-authorization"
  | "erc7715-advanced"
  | "erc7710-payment"
  | "redelegation";

export type PermissionStatus = "proposed" | "granted" | "revoked" | "expired";

export interface PermissionGrant {
  id: string;
  caseId: string;
  permissionType: PermissionType;
  delegate: string;
  scope: string[];
  spendCapUsd?: number;
  token?: string;
  expiresAt: string;
  redelegatable: boolean;
  status: PermissionStatus;
  createdAt: string;
}

export type RelayerStatus = "submitted" | "relayed" | "confirmed" | "failed";

export interface RelayerEvent {
  id: string;
  caseId: string;
  provider: "1shot";
  eventType: RelayerStatus;
  status: RelayerStatus;
  txHash?: string;
  userOpHash?: string;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
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
