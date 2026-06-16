import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_POLICY_MATRIX,
  ALL_ACTION_TYPES,
  requiresSourceVerificationForAction
} from "../../src/domain/policyMatrix.js";
import { evaluateProposedAction } from "../../src/domain/policy.js";
import type { ActionType } from "../../src/domain/types.js";

const BASE_INPUT = {
  authorityBasis: "self" as const,
  destination: "Example Destination",
  purpose: "Remove exposed profile",
  identifiers: ["email" as const],
  dataToDisclose: ["email" as const],
  sourceVerified: true,
  hasApproval: true
};

test("policy matrix covers every ActionType", () => {
  const expected: ActionType[] = [
    "people-search-discovery",
    "broker-opt-out",
    "search-result-removal",
    "gdpr-erasure",
    "uk-gdpr-erasure",
    "hibp-email-check",
    "pwned-password-range-check",
    "follow-up",
    "escalation-draft",
    "dmca-takedown",
    "platform-abuse-report"
  ];
  assert.deepEqual([...ALL_ACTION_TYPES].sort(), [...expected].sort());
  for (const actionType of expected) {
    assert.ok(ACTION_POLICY_MATRIX[actionType], `missing matrix entry for ${actionType}`);
  }
});

test("source verification matrix matches policy evaluation", () => {
  for (const actionType of ALL_ACTION_TYPES) {
    const requiresSource = requiresSourceVerificationForAction(actionType);
    const allowed = evaluateProposedAction({ ...BASE_INPUT, actionType, sourceVerified: true });
    const blocked = evaluateProposedAction({ ...BASE_INPUT, actionType, sourceVerified: false });
    assert.equal(allowed.allowed, true, `${actionType} should allow verified source`);
    if (requiresSource) {
      assert.equal(blocked.allowed, false, `${actionType} should block unverified source`);
      assert.ok(blocked.reasons.includes("source-verification-required"));
    } else {
      assert.equal(blocked.allowed, true, `${actionType} should not require source verification`);
    }
  }
});

test("global blocked disclosure categories apply to every action type", () => {
  for (const actionType of ALL_ACTION_TYPES) {
    for (const category of ["password", "ssn", "payment"] as const) {
      const decision = evaluateProposedAction({
        ...BASE_INPUT,
        actionType,
        dataToDisclose: [category]
      });
      assert.equal(decision.allowed, false, `${actionType} should block ${category}`);
    }
  }
});

test("sensitive disclosure requires approval for every action type", () => {
  for (const actionType of ALL_ACTION_TYPES) {
    const decision = evaluateProposedAction({
      ...BASE_INPUT,
      actionType,
      hasApproval: false
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.requiresApproval, true);
    assert.ok(decision.reasons.includes("explicit-action-approval-required"));
  }
});