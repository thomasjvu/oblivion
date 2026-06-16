import type { ActionType, IdentifierCategory } from "./types.js";

export interface ActionPolicySpec {
  requiresSourceVerification: boolean;
  blockedDisclosureCategories: IdentifierCategory[];
  description: string;
}

export const GLOBAL_BLOCKED_DISCLOSURE: IdentifierCategory[] = ["password", "ssn", "payment"];

export const PROHIBITED_ACTION_TERMS = [
  "dark web",
  "breach dump",
  "stolen database",
  "buy leaked",
  "leaked credentials",
  "forum dump"
] as const;

export const ACTION_POLICY_MATRIX: Record<ActionType, ActionPolicySpec> = {
  "people-search-discovery": {
    requiresSourceVerification: false,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Discovery-only; destination/purpose must not reference breach dumps."
  },
  "broker-opt-out": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Per-broker opt-out requires verified official removal path."
  },
  "search-result-removal": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Search suppression requires verified Google removal guidance."
  },
  "gdpr-erasure": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Controller erasure request requires verified rights path."
  },
  "uk-gdpr-erasure": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "UK GDPR erasure request requires verified rights path."
  },
  "hibp-email-check": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Managed plaintext email check requires TEE pass and verified HIBP source."
  },
  "pwned-password-range-check": {
    requiresSourceVerification: false,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "K-anonymity password range check; no destination disclosure."
  },
  "follow-up": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Follow-up contact requires verified destination."
  },
  "escalation-draft": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Escalation draft requires verified destination."
  },
  "dmca-takedown": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "DMCA notice requires verified host abuse path."
  },
  "platform-abuse-report": {
    requiresSourceVerification: true,
    blockedDisclosureCategories: GLOBAL_BLOCKED_DISCLOSURE,
    description: "Platform abuse report requires verified contact path."
  }
};

export const ALL_ACTION_TYPES = Object.keys(ACTION_POLICY_MATRIX) as ActionType[];

export function actionPolicySpec(actionType: ActionType): ActionPolicySpec {
  return ACTION_POLICY_MATRIX[actionType];
}

export function requiresSourceVerificationForAction(actionType: ActionType): boolean {
  return ACTION_POLICY_MATRIX[actionType].requiresSourceVerification;
}

export function blockedDisclosureForAction(actionType: ActionType): IdentifierCategory[] {
  return ACTION_POLICY_MATRIX[actionType].blockedDisclosureCategories;
}