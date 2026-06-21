import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processDueRechecks } from "../../src/domain/recheck.js";
import type { CaseRecord, FollowUp } from "../../src/domain/types.js";
import { loadFileStore, persistStore } from "../../src/storage/fileStore.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("recheck scheduler mutations survive file store reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oblivion-scheduler-"));
  const path = join(dir, "oblivion.json");
  try {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const caseRecord: CaseRecord = {
      id: "case_scheduler",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      retentionDays: 30,
      encryptedVaultPointer: "vault_scheduler",
      createdAt: now,
      updatedAt: now
    };
    store.cases.set(caseRecord.id, caseRecord);
    const followUp: FollowUp = {
      id: "followup_scheduler",
      caseId: caseRecord.id,
      dueDate: new Date(Date.now() - 86_400_000).toISOString(),
      status: "pending",
      expectedResponseWindow: "Recheck",
      escalationPath: "Follow up"
    };
    store.followUps.set(followUp.id, followUp);

    assert.equal(await processDueRechecks(store), 1);
    assert.equal(store.followUps.get(followUp.id)?.status, "triggered");
    assert.equal(store.isDirty(), true);

    persistStore(store, path);
    const reloaded = loadFileStore(path);
    assert.equal(reloaded.followUps.get(followUp.id)?.status, "triggered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});