import type { ActionType, Approval, AuthorityBasis, IdentifierCategory } from "./types.js";
import { detectForbiddenSecrets } from "./redaction.js";
import {
  ACTION_POLICY_MATRIX,
  ALL_ACTION_TYPES,
  PROHIBITED_ACTION_TERMS,
  actionPolicySpec,
  requiresSourceVerificationForAction
} from "./policyMatrix.js";

export { ACTION_POLICY_MATRIX, ALL_ACTION_TYPES, actionPolicySpec, requiresSourceVerificationForAction };
export { requiresSourceVerificationForAction as requiresSourceVerification };

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
  const spec = actionPolicySpec(input.actionType);

  if (!input.authorityBasis) reasons.push("missing-authority-basis");
  if (!input.destination.trim()) reasons.push("missing-destination");
  if (!input.purpose.trim()) reasons.push("missing-purpose");
  if (forbiddenSecrets.length > 0) reasons.push(...forbiddenSecrets);
  for (const category of spec.blockedDisclosureCategories) {
    if (input.dataToDisclose.includes(category)) {
      if (category === "password") reasons.push("password-disclosure-blocked");
      else if (category === "ssn") reasons.push("ssn-disclosure-blocked");
      else if (category === "payment") reasons.push("payment-disclosure-blocked");
    }
  }
  if (PROHIBITED_ACTION_TERMS.some((term) => combinedText.includes(term))) {
    reasons.push("dark-web-or-breach-dump-access-blocked");
  }
  if (spec.requiresSourceVerification && !input.sourceVerified) {
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