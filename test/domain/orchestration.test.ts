import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/domain/errors.js";
import { proposeApprovedAction } from "../../src/domain/approvals.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { CaseRecord } from "../../src/domain/types.js";

function seedCase(store: MemoryStore): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_orchestration",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_orchestration",
    retentionDays: 90,
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

test("proposeApprovedAction stores approval and action when policy allows", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const result = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      purpose: "Remove profile",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: true
    }
  });
  assert.equal(result.approval.status, "pending");
  assert.equal(result.action.executionStatus, "awaiting-approval");
  assert.equal(store.approvalsForCase(caseRecord.id).length, 1);
  assert.equal(store.actionsForCase(caseRecord.id).length, 1);
});

test("proposeApprovedAction rejects policy-blocked disclosure", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  assert.throws(
    () =>
      proposeApprovedAction({
        store,
        caseRecord,
        body: {
          caseId: caseRecord.id,
          actionType: "broker-opt-out",
          destination: "Example Broker",
          purpose: "Remove profile",
          identifiers: ["email"],
          dataToDisclose: ["password"],
          sourceVerified: true
        }
      }),
    (error: unknown) => error instanceof DomainError && error.statusCode === 422 && error.code === "policy-blocked"
  );
  assert.equal(store.approvalsForCase(caseRecord.id).length, 0);
});

test("proposeApprovedAction ignores client sourceVerified and uses server registry", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const result = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      purpose: "Remove profile",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: false
    }
  });
  assert.equal(result.approval.actionType, "broker-opt-out");
});