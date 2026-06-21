import assert from "node:assert/strict";
import test from "node:test";
import { proposeApprovedAction } from "../../src/domain/approvals.js";
import type { CaseRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("proposeApprovedAction ignores client sourceVerified false for verified connectors", () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_source",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_source_test",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  const result = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "hibp-email-check",
      destination: "HIBP",
      purpose: "Check breaches",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: false
    }
  });
  assert.equal(result.approval.actionType, "hibp-email-check");
});