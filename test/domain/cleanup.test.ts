import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceAgentPlan,
  buildAgentPlanView,
  createAgentPlan,
  getPreset,
  presetSkipsMatchReview,
  presetUsesBrokerDiscovery
} from "../../src/domain/cleanup.js";
import type { AgentPlan, CaseRecord, RedactedScope } from "../../src/domain/types.js";

function minimalScope(personLabel = "User"): RedactedScope {
  return {
    personLabel,
    aliases: [],
    approvedIdentifierLabels: [],
    sensitiveConstraints: []
  };
}

function baseCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date().toISOString();
  return {
    id: "case_cleanup",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_cleanup",
    retentionDays: 90,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function basePlan(caseRecord: CaseRecord, overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    ...createAgentPlan({ caseRecord, presetId: "people-search-cleanup" }),
    ...overrides
  };
}

test("advanceAgentPlan blocks without minimum identifiers", () => {
  const caseRecord = baseCase();
  const plan = basePlan(caseRecord);
  const advanced = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: false
  });
  assert.equal(advanced.currentStep, "collect-minimum-identifiers");
  assert.ok(advanced.blockedReasons.includes("minimum-identifiers-needed"));
});

test("advanceAgentPlan moves to discover after trust when identifiers exist", () => {
  const caseRecord = baseCase({ redactedScope: minimalScope() });
  let plan = basePlan(caseRecord);
  plan = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(plan.currentStep, "verify-trust");
  plan = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(plan.currentStep, "discover-candidates");
});

test("advanceAgentPlan skips match review for breach-exposure preset", () => {
  const caseRecord = baseCase({ redactedScope: minimalScope() });
  const plan = createAgentPlan({ caseRecord, presetId: "breach-exposure" });
  const advanced = advanceAgentPlan({
    plan: { ...plan, currentStep: "discover-candidates" },
    caseRecord,
    findingsCount: 0,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(advanced.currentStep, "verify-removal-path");
  assert.ok(presetSkipsMatchReview("breach-exposure"));
});

test("advanceAgentPlan requires approval before execution", () => {
  const caseRecord = baseCase({ redactedScope: minimalScope() });
  const plan = basePlan(caseRecord, { currentStep: "request-approval" });
  const blocked = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 1,
    pendingFindingsCount: 0,
    approvalsPending: 1,
    actionsReady: 0,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(blocked.currentStep, "request-approval");
  assert.ok(blocked.blockedReasons.includes("approval-required"));

  const ready = advanceAgentPlan({
    plan,
    caseRecord,
    findingsCount: 1,
    pendingFindingsCount: 0,
    approvalsPending: 0,
    actionsReady: 1,
    submittedActions: 0,
    trustPass: true
  });
  assert.equal(ready.currentStep, "execute-approved-action");
});

test("buildAgentPlanView marks blocked steps in visual nodes", () => {
  const caseRecord = baseCase({ redactedScope: minimalScope() });
  const plan = basePlan(caseRecord, {
    currentStep: "request-approval",
    blockedReasons: ["approval-required"]
  });
  const view = buildAgentPlanView(plan);
  assert.ok(view.visualNodes.some((node) => node.status === "blocked"));
});

test("preset helpers classify discovery routes", () => {
  assert.equal(presetUsesBrokerDiscovery("people-search-cleanup"), true);
  assert.equal(presetUsesBrokerDiscovery("breach-exposure"), false);
  assert.equal(getPreset("gdpr-erasure").id, "gdpr-erasure");
});