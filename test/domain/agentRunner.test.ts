import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/api/errors.js";
import { createAgentPlan } from "../../src/domain/cleanup.js";
import { runCleanupAgentStep } from "../../src/domain/agentRunner.js";
import type { TrustCenterConfig } from "../../src/domain/attestation.js";
import type { CaseRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

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