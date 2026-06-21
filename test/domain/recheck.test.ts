import assert from "node:assert/strict";
import test from "node:test";
import { findDueFollowUps, processDueRechecks, runCaseRecheck } from "../../src/domain/recheck.js";
import type { CaseRecord, FollowUp } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedCase(store: MemoryStore): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_recheck",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_recheck",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

function seedFollowUp(caseId: string, dueDate: string, status: FollowUp["status"] = "pending"): FollowUp {
  return {
    id: `followup_${crypto.randomUUID()}`,
    caseId,
    dueDate,
    status,
    expectedResponseWindow: "Recheck listing",
    escalationPath: "Follow up with broker"
  };
}

test("findDueFollowUps returns only pending follow-ups past due date", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const due = seedFollowUp(caseRecord.id, past);
  const upcoming = seedFollowUp(caseRecord.id, future);
  const triggered = seedFollowUp(caseRecord.id, past, "triggered");
  store.followUps.set(due.id, due);
  store.followUps.set(upcoming.id, upcoming);
  store.followUps.set(triggered.id, triggered);

  const found = findDueFollowUps(store, caseRecord.id);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, due.id);
});

test("runCaseRecheck triggers overdue follow-ups and marks them triggered", async () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const followUp = seedFollowUp(caseRecord.id, past);
  store.followUps.set(followUp.id, followUp);

  const result = await runCaseRecheck(store, caseRecord.id);
  assert.equal(result.triggered.length, 1);
  assert.equal(result.triggered[0]?.status, "triggered");
  assert.ok(result.triggered[0]?.lastTriggeredAt);
  assert.equal(store.followUps.get(followUp.id)?.status, "triggered");
});

test("processDueRechecks is idempotent for already triggered follow-ups", async () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const followUp = seedFollowUp(caseRecord.id, past);
  store.followUps.set(followUp.id, followUp);

  assert.equal(await processDueRechecks(store), 1);
  assert.equal(await processDueRechecks(store), 0);
});