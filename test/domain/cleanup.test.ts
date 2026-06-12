import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/api/errors.js";
import {
  advanceAgentPlan,
  buildAgentPlanView,
  createAgentPlan,
  getPreset,
  presetSkipsMatchReview,
  presetUsesBrokerDiscovery
} from "../../src/domain/cleanup.js";
import { runCleanupAgentStep } from "../../src/domain/agentRunner.js";
import { resolveExecutionStatusAfterExecute } from "../../src/domain/executor.js";
import type { TrustCenterConfig } from "../../src/domain/attestation.js";
import type { AgentPlan, CaseRecord, RedactedScope } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

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

const trustCenterConfig = async (): Promise<TrustCenterConfig> => ({
  deploymentVersion: "test",
  sourceCommit: "abc123",
  expectedComposeHash: "sha256:deadbeef",
  imageDigests: [],
  verificationInstructions: []
});

function seedCase(store: MemoryStore, overrides: Partial<CaseRecord> = {}): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_agent_runner",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_agent_runner",
    retentionDays: 90,
    createdAt: now,
    updatedAt: now,
    redactedScope: {
      personLabel: "Test User",
      aliases: [],
      approvedIdentifierLabels: ["email"],
      sensitiveConstraints: []
    },
    ...overrides
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

test("runCleanupAgentStep throws preset-required when no agent plan exists", async () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);

  await assert.rejects(
    () =>
      runCleanupAgentStep({
        store,
        caseRecord,
        trustCenterConfig
      }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.message === "preset-required"
  );
});

test("runCleanupAgentStep maps official-path discovery for breach-exposure preset", async () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const plan = createAgentPlan({ caseRecord, presetId: "breach-exposure" });
  plan.currentStep = "discover-candidates";
  store.agentPlans.set(plan.id, plan);

  const result = await runCleanupAgentStep({
    store,
    caseRecord,
    trustCenterConfig
  });

  assert.equal(result.artifacts.length, 1);
  const artifact = result.artifacts[0] as { connector: { summary: string }; timeline: { title: string } };
  assert.ok(artifact.connector);
  assert.equal(artifact.timeline.title, "Official path mapped");
  assert.equal(store.connectorResultsForCase(caseRecord.id).length, 1);
  assert.equal(store.exposuresForCase(caseRecord.id).length, 0);
});

test("resolveExecutionStatusAfterExecute maps connector outcomes", () => {
  assert.equal(
    resolveExecutionStatusAfterExecute({
      mode: "live",
      connectorResult: {
        id: "result_1",
        caseId: "case_1",
        connectorId: "hibp-email",
        status: "ready",
        sourceUrl: "https://haveibeenpwned.com/api/v3",
        confidence: "high",
        requiresUserHandoff: false,
        summary: "ok",
        createdAt: new Date().toISOString()
      }
    }),
    "executed"
  );
  assert.equal(resolveExecutionStatusAfterExecute({ mode: "record-only" }), "recorded");
  assert.equal(
    resolveExecutionStatusAfterExecute({
      mode: "live",
      connectorResult: {
        id: "result_1",
        caseId: "case_1",
        connectorId: "hibp-email",
        status: "failed",
        sourceUrl: "https://haveibeenpwned.com/api/v3",
        confidence: "low",
        requiresUserHandoff: false,
        summary: "failed",
        createdAt: new Date().toISOString()
      }
    }),
    "failed"
  );
});