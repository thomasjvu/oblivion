import assert from "node:assert/strict";
import test from "node:test";
import { purgeCaseData } from "../../src/domain/purgeCase.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { Approval, CaseRecord } from "../../src/domain/types.js";

function seedPartnerCase(store: MemoryStore, id: string, partnerId: string): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id,
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: `vault_${id}`,
    retentionDays: 90,
    partnerId,
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

function seedApproval(store: MemoryStore, caseId: string, suffix: string): Approval {
  const approval: Approval = {
    id: `approval_${suffix}`,
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

test("casesForPartner uses partner index and ignores deleted cases", () => {
  const store = new MemoryStore();
  seedPartnerCase(store, "case_p1", "partner_a");
  seedPartnerCase(store, "case_p2", "partner_a");
  seedPartnerCase(store, "case_other", "partner_b");
  const deleted = seedPartnerCase(store, "case_deleted", "partner_a");
  deleted.deletedAt = new Date().toISOString();
  store.cases.set(deleted.id, deleted);

  assert.equal(store.casesForPartner("partner_a").length, 2);
  assert.equal(store.casesForPartner("partner_b").length, 1);
});

test("purgeCaseData clears indexed case records only for target case", () => {
  const store = new MemoryStore();
  seedApproval(store, "case_keep", "keep");
  seedApproval(store, "case_drop", "drop");

  purgeCaseData(store, "case_drop");

  assert.equal(store.approvalsForCase("case_keep").length, 1);
  assert.equal(store.approvalsForCase("case_drop").length, 0);
});