import test from "node:test";
import assert from "node:assert/strict";
import { createAgentPlan } from "../src/domain/cleanup.js";
import { applyFindingDecision } from "../src/domain/exposureDiscovery.js";
import { createBreachExposureApprovals, createBrokerOptOutApprovals } from "../src/domain/orchestration.js";
import { MemoryStore } from "../src/storage/memoryStore.js";
import type { Exposure } from "../src/domain/types.js";

test("createBrokerOptOutApprovals creates one approval per confirmed broker", () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const caseRecord = {
    id: "case_broker_test",
    jurisdiction: "US" as const,
    authorityBasis: "self" as const,
    riskLevel: "standard" as const,
    encryptedVaultPointer: "vault_test",
    retentionDays: 30,
    createdAt: now,
    updatedAt: now,
    redactedScope: {
      personLabel: "John Smith",
      aliases: [],
      approvedIdentifierLabels: ["city-state"],
      sensitiveConstraints: []
    }
  };
  store.cases.set(caseRecord.id, caseRecord);
  const plan = createAgentPlan({ caseRecord, presetId: "people-search-cleanup" });
  store.agentPlans.set(plan.id, plan);

  const exposures: Exposure[] = [
    {
      id: "exposure_1",
      caseId: caseRecord.id,
      sourceUrl: "https://www.spokeo.com/John-Smith",
      visibleDataCategories: ["legal-name"],
      confidence: "high",
      createdAt: new Date().toISOString(),
      matchStatus: "confirmed",
      brokerId: "spokeo",
      brokerLabel: "Spokeo",
      officialOptOutUrl: "https://www.spokeo.com/opt-out",
      submissionMethod: "web-form",
      teeAutomatable: true
    },
    {
      id: "exposure_2",
      caseId: caseRecord.id,
      sourceUrl: "https://www.beenverified.com/profile/x",
      visibleDataCategories: ["legal-name"],
      confidence: "high",
      createdAt: new Date().toISOString(),
      matchStatus: "confirmed",
      brokerId: "beenverified",
      brokerLabel: "BeenVerified",
      officialOptOutUrl: "https://www.beenverified.com/app/optout/search",
      submissionMethod: "web-form",
      teeAutomatable: true
    }
  ];
  for (const exposure of exposures) {
    store.exposures.set(exposure.id, exposure);
  }

  const approvals = createBrokerOptOutApprovals(store, caseRecord, plan);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].action.brokerId, "spokeo");
  assert.equal(approvals[0].action.exposureId, "exposure_1");
  assert.match(approvals[0].approval.destination, /spokeo\.com\/opt-out/);
  assert.deepEqual(approvals[0].approval.dataToDisclose, ["legal-name", "email", "city-state"]);
});

test("applyFindingDecision enriches broker metadata from catalog", () => {
  const exposure = applyFindingDecision(
    {
      id: "exposure_x",
      caseId: "case_x",
      sourceUrl: "https://www.intelius.com/browse/people/",
      visibleDataCategories: ["legal-name"],
      confidence: "medium",
      createdAt: new Date().toISOString(),
      matchStatus: "pending"
    },
    "confirmed"
  );
  assert.equal(exposure.brokerId, "intelius");
  assert.equal(exposure.submissionMethod, "web-form");
  assert.equal(exposure.teeAutomatable, true);
});

test("createBreachExposureApprovals prepares HIBP email and password range cards", () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const caseRecord = {
    id: "case_breach_test",
    jurisdiction: "US" as const,
    authorityBasis: "self" as const,
    riskLevel: "standard" as const,
    encryptedVaultPointer: "vault_breach",
    retentionDays: 30,
    createdAt: now,
    updatedAt: now,
    redactedScope: {
      personLabel: "Jane Doe",
      aliases: [],
      approvedIdentifierLabels: ["email"],
      sensitiveConstraints: []
    }
  };
  store.cases.set(caseRecord.id, caseRecord);
  const approvals = createBreachExposureApprovals(store, caseRecord);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].action.actionType, "hibp-email-check");
  assert.equal(approvals[1].action.actionType, "pwned-password-range-check");
  assert.deepEqual(approvals[1].approval.dataToDisclose, []);
});