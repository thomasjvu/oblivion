import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { Approval, CaseRecord } from "../../src/domain/types.js";

function seedCase(store: MemoryStore, id: string): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id,
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: `vault_${id}`,
    retentionDays: 90,
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

function seedApproval(store: MemoryStore, caseId: string): Approval {
  const approval: Approval = {
    id: `approval_${caseId}`,
    caseId,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove profile",
    disclosureRisk: "Disclosure to broker",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  store.approvals.set(approval.id, approval);
  return approval;
}

test("case query helpers isolate records by case id", () => {
  const store = new MemoryStore();
  seedCase(store, "case_a");
  seedCase(store, "case_b");
  seedApproval(store, "case_a");
  seedApproval(store, "case_b");

  assert.equal(store.approvalsForCase("case_a").length, 1);
  assert.equal(store.approvalsForCase("case_b").length, 1);
  assert.equal(store.approvalsForCase("case_missing").length, 0);
});

test("getCaseOrThrow rejects deleted cases", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store, "case_deleted");
  caseRecord.deletedAt = new Date().toISOString();
  store.cases.set(caseRecord.id, caseRecord);
  assert.throws(() => store.getCaseOrThrow("case_deleted"), /case-not-found/);
});