import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { createCaseRecord } from "../../src/domain/cases.js";
import { purgeCaseData } from "../../src/domain/purgeCase.js";
import { createTimelineEvent } from "../../src/domain/agentTimeline.js";
import type { Approval, Exposure } from "../../src/domain/types.js";

test("purgeCaseData removes all case-scoped records", () => {
  const store = new MemoryStore();
  const { caseRecord } = createCaseRecord({ jurisdiction: "US", authorityBasis: "self" });
  store.cases.set(caseRecord.id, caseRecord);
  const timeline = createTimelineEvent(caseRecord.id, "x402", "test", "purge");
  store.agentTimeline.set(timeline.id, timeline);
  const approval: Approval = {
    id: "approval_1",
    caseId: caseRecord.id,
    actionType: "broker-opt-out",
    destination: "broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove profile",
    disclosureRisk: "Disclosure to broker",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  store.approvals.set(approval.id, approval);
  const exposure: Exposure = {
    id: "exposure_1",
    caseId: caseRecord.id,
    sourceUrl: "https://example.com/profile",
    visibleDataCategories: ["email"],
    confidence: "medium",
    matchStatus: "pending",
    removalStatus: "not-started",
    createdAt: new Date().toISOString()
  };
  store.exposures.set(exposure.id, exposure);

  purgeCaseData(store, caseRecord.id);

  assert.equal(store.approvalsForCase(caseRecord.id).length, 0);
  assert.equal(store.exposuresForCase(caseRecord.id).length, 0);
  assert.equal(store.agentTimelineForCase(caseRecord.id).length, 0);
  assert.ok(store.cases.has(caseRecord.id));
});