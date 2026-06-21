import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { persistStore } from "../../src/storage/fileStore.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { createSqliteStore } from "../../src/storage/sqliteStore.js";
import type { Approval, CaseRecord } from "../../src/domain/types.js";

test("sqlite store round-trips case-scoped snapshot data", () => {
  const dir = mkdtempSync(join(tmpdir(), "oblivion-sqlite-"));
  const dbPath = join(dir, "oblivion.db");
  try {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const caseRecord: CaseRecord = {
      id: "case_sqlite",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      encryptedVaultPointer: "vault_sqlite",
      retentionDays: 90,
      createdAt: now,
      updatedAt: now
    };
    const approval: Approval = {
      id: "approval_sqlite",
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      identifiersApproved: ["email"],
      dataToDisclose: ["email"],
      purpose: "Remove profile",
      disclosureRisk: "Disclosure to broker",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
      createdAt: now
    };
    store.cases.set(caseRecord.id, caseRecord);
    store.approvals.set(approval.id, approval);
    store.markDirty();
    persistStore(store, dbPath);

    const loaded = createSqliteStore(dbPath);
    assert.equal(loaded.cases.get(caseRecord.id)?.id, caseRecord.id);
    assert.equal(loaded.approvalsForCase(caseRecord.id).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});