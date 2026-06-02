import test from "node:test";
import assert from "node:assert/strict";
import { canExecuteWithApproval, evaluateProposedAction } from "../src/domain/policy.js";
import type { Approval } from "../src/domain/types.js";

test("blocks full SSN and password disclosure", () => {
  const decision = evaluateProposedAction({
    authorityBasis: "self",
    actionType: "broker-opt-out",
    destination: "Example Broker",
    purpose: "Remove exposed profile",
    identifiers: ["email"],
    dataToDisclose: ["password"],
    plaintextPreview: "My ssn is 123-45-6789",
    sourceVerified: true,
    hasApproval: true
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join(","), /full-ssn/);
  assert.match(decision.reasons.join(","), /password-disclosure-blocked/);
});

test("allows proposing sensitive action but requires explicit approval", () => {
  const decision = evaluateProposedAction({
    authorityBasis: "self",
    actionType: "broker-opt-out",
    destination: "Example Broker",
    purpose: "Remove exposed profile",
    identifiers: ["email"],
    dataToDisclose: ["email"],
    sourceVerified: true,
    hasApproval: false
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.ok(decision.reasons.includes("explicit-action-approval-required"));
});

test("blocks dark web dump access", () => {
  const decision = evaluateProposedAction({
    authorityBasis: "self",
    actionType: "people-search-discovery",
    destination: "dark web breach dump",
    purpose: "Find leaked credentials",
    identifiers: [],
    dataToDisclose: [],
    hasApproval: true
  });

  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("dark-web-or-breach-dump-access-blocked"));
});

test("execution requires live approved approval", () => {
  const approval: Approval = {
    id: "approval_1",
    caseId: "case_1",
    actionType: "broker-opt-out",
    destination: "Example Broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove",
    disclosureRisk: "Disclosure to broker",
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    status: "approved",
    createdAt: new Date().toISOString()
  };

  assert.equal(canExecuteWithApproval(approval).allowed, true);
  approval.status = "pending";
  assert.equal(canExecuteWithApproval(approval).allowed, false);
});
