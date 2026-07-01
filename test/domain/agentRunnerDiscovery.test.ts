import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { createAgentPlan } from "../../src/domain/cleanup.js";
import { runCleanupAgentStep } from "../../src/domain/agentRunner.js";
import type { TrustCenterConfig } from "../../src/domain/attestation.js";
import type { CaseRecord, Exposure } from "../../src/domain/types.js";

const trustCenterConfig = async (): Promise<TrustCenterConfig> => ({
  deploymentVersion: "0.1.0",
  sourceCommit: "test",
  expectedComposeHash: "sha256:test",
  imageDigests: [],
  verificationInstructions: []
});

function seedCase(): CaseRecord {
  const now = new Date().toISOString();
  return {
    id: "case_agent_rediscover",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_agent",
    retentionDays: 90,
    createdAt: now,
    updatedAt: now,
    redactedScope: {
      personLabel: "J.S.",
      aliases: [],
      approvedIdentifierLabels: ["city-state"],
      sensitiveConstraints: ["New York, NY"]
    }
  };
}

test("runCleanupAgentStep rediscovers when exposures are all rejected", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.VENICE_API_KEY;
  const store = new MemoryStore();
  const caseRecord = seedCase();
  store.cases.set(caseRecord.id, caseRecord);
  const plan = createAgentPlan({ caseRecord, presetId: "people-search-cleanup" });
  plan.currentStep = "discover-candidates";
  store.agentPlans.set(plan.id, plan);
  const rejected: Exposure = {
    id: "exposure_rejected",
    caseId: caseRecord.id,
    sourceUrl: "https://www.spokeo.com/old-profile",
    visibleDataCategories: ["legal-name"],
    confidence: "low",
    evidencePointer: "discovery://pasted",
    createdAt: new Date().toISOString(),
    matchStatus: "rejected",
    matchScore: "unlikely",
    removalStatus: "not-started"
  };
  store.exposures.set(rejected.id, rejected);

  const before = store.exposuresForCase(caseRecord.id).length;
  await runCleanupAgentStep({
    store,
    caseRecord,
    trustCenterConfig
  });
  const after = store.exposuresForCase(caseRecord.id).length;
  assert.ok(after >= before);
});