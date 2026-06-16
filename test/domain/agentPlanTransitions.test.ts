import test from "node:test";
import assert from "node:assert/strict";
import { advanceAgentPlan, createAgentPlan } from "../../src/domain/cleanup.js";
import type { CaseRecord } from "../../src/domain/types.js";

function seedCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date().toISOString();
  return {
    id: "case_transition",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_transition",
    retentionDays: 90,
    createdAt: now,
    updatedAt: now,
    redactedScope: {
      personLabel: "Test User",
      aliases: [],
      approvedIdentifierLabels: [],
      sensitiveConstraints: []
    },
    ...overrides
  };
}

test("advanceAgentPlan blocks confirm-matches when pending findings remain", () => {
  const caseRecord = seedCase();
  const plan = createAgentPlan({ caseRecord, presetId: "people-search-cleanup" });
  plan.currentStep = "confirm-matches";
  const advanced = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 2,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(advanced.currentStep, "confirm-matches");
  assert.ok(advanced.blockedReasons.includes("candidate-confirmation-needed"));
});

test("advanceAgentPlan blocks confirm-matches when no confirmed findings", () => {
  const caseRecord = seedCase();
  const plan = createAgentPlan({ caseRecord, presetId: "people-search-cleanup" });
  plan.currentStep = "confirm-matches";
  const advanced = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(advanced.currentStep, "confirm-matches");
  assert.ok(advanced.blockedReasons.includes("no-confirmed-matches"));
});

test("advanceAgentPlan advances confirm-matches to verify-removal-path when ready", () => {
  const caseRecord = seedCase();
  const plan = createAgentPlan({ caseRecord, presetId: "people-search-cleanup" });
  plan.currentStep = "confirm-matches";
  const advanced = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 1,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(advanced.currentStep, "verify-removal-path");
  assert.equal(advanced.blockedReasons.length, 0);
});