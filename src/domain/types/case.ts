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
  | "infringing-url"
  | "original-work-ref"
  | "unknown";

export type BrokerSubmissionMethod = "web-form" | "email" | "portal" | "postal" | "drop";

export type ActionType =
  | "people-search-discovery"
  | "broker-opt-out"
  | "search-result-removal"
  | "gdpr-erasure"
  | "uk-gdpr-erasure"
  | "hibp-email-check"
  | "pwned-password-range-check"
  | "follow-up"
  | "escalation-draft"
  | "dmca-takedown"
  | "platform-abuse-report";

export type ApprovalStatus = "pending" | "approved" | "expired" | "revoked" | "used";

export type ExecutionStatus =
  | "draft"
  | "awaiting-approval"
  | "ready"
  | "recorded"
  | "executed"
  | "blocked"
  | "failed";

export interface EncryptedBlob {
  alg: "AES-256-GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  aad?: string;
}

export interface CasePreferences {
  operatorEmailRelay: boolean;
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
  casePreferences?: CasePreferences;
  accessTokenHash?: string;
  partnerId?: string;
  externalRef?: string;
  callbackUrl?: string;
  activatedAt?: string;
  activatedWalletKey?: string;
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
  submissionMethod?: BrokerSubmissionMethod;
  teeAutomatable?: boolean;
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
  brokerId?: string;
  exposureId?: string;
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
  brokerId?: string;
  brokerLabel?: string;
  exposureId?: string;
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
  mailtoUrl?: string;
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
  activated: boolean;
  activationRequired: boolean;
}