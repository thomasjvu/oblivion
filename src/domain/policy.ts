import type {
  ActionType,
  Approval,
  AuthorityBasis,
  IdentifierCategory
} from "./types.js";
import { detectForbiddenSecrets } from "./redaction.js";

const SENSITIVE_IDENTIFIERS = new Set<IdentifierCategory>([
  "email",
  "phone",
  "address",
  "date-of-birth",
  "relative",
  "workplace",
  "school",
  "government-id",
  "ssn",
  "password",
  "payment"
]);

const PROHIBITED_ACTION_TERMS = [
  "dark web",
  "breach dump",
  "stolen database",
  "buy leaked",
  "leaked credentials",
  "forum dump"
];

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  requiresApproval: boolean;
}

export interface ProposedActionInput {
  authorityBasis: AuthorityBasis;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  plaintextPreview?: string;
  sourceVerified?: boolean;
  hasApproval?: boolean;
}

export function requiresSensitiveApproval(categories: IdentifierCategory[]): boolean {
  return categories.some((category) => SENSITIVE_IDENTIFIERS.has(category));
}

export function evaluateProposedAction(input: ProposedActionInput): PolicyDecision {
  const reasons: string[] = [];
  const combinedText = `${input.destination} ${input.purpose} ${input.plaintextPreview ?? ""}`.toLowerCase();
  const forbiddenSecrets = detectForbiddenSecrets(input.plaintextPreview ?? "");

  if (!input.authorityBasis) reasons.push("missing-authority-basis");
  if (!input.destination.trim()) reasons.push("missing-destination");
  if (!input.purpose.trim()) reasons.push("missing-purpose");
  if (forbiddenSecrets.length > 0) reasons.push(...forbiddenSecrets);
  if (input.dataToDisclose.includes("password")) reasons.push("password-disclosure-blocked");
  if (input.dataToDisclose.includes("ssn")) reasons.push("ssn-disclosure-blocked");
  if (input.dataToDisclose.includes("payment")) reasons.push("payment-disclosure-blocked");
  if (PROHIBITED_ACTION_TERMS.some((term) => combinedText.includes(term))) {
    reasons.push("dark-web-or-breach-dump-access-blocked");
  }
  if (requiresSourceVerification(input.actionType) && !input.sourceVerified) {
    reasons.push("source-verification-required");
  }

  const requiresApproval =
    requiresSensitiveApproval(input.identifiers) || requiresSensitiveApproval(input.dataToDisclose);

  if (requiresApproval && input.hasApproval !== true) {
    reasons.push("explicit-action-approval-required");
  }

  const blockingReasons = reasons.filter((reason) => reason !== "explicit-action-approval-required");
  return {
    allowed: blockingReasons.length === 0,
    reasons,
    requiresApproval
  };
}

export function requiresSourceVerification(actionType: ActionType): boolean {
  return [
    "broker-opt-out",
    "search-result-removal",
    "gdpr-erasure",
    "uk-gdpr-erasure",
    "hibp-email-check",
    "follow-up",
    "escalation-draft",
    "dmca-takedown",
    "platform-abuse-report"
  ].includes(actionType);
}

export function canExecuteWithApproval(approval: Approval, now = new Date()): PolicyDecision {
  const reasons: string[] = [];
  if (approval.status !== "approved") reasons.push("approval-not-approved");
  if (new Date(approval.expiresAt).getTime() <= now.getTime()) reasons.push("approval-expired");
  return {
    allowed: reasons.length === 0,
    reasons,
    requiresApproval: true
  };
}
