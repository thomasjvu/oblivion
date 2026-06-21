import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileStore, persistStore, scheduleStorePersist } from "../../src/storage/fileStore.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { CaseRecord } from "../../src/domain/types.js";

test("file store persists and reloads case records", () => {
  const dir = mkdtempSync(join(tmpdir(), "oblivion-store-"));
  const path = join(dir, "oblivion.json");
  try {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const caseRecord: CaseRecord = {
      id: "case_persist",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      encryptedVaultPointer: "vault_persist",
      retentionDays: 90,
      createdAt: now,
      updatedAt: now
    };
    store.cases.set(caseRecord.id, caseRecord);
    store.markDirty();
    persistStore(store, path);
    assert.equal(store.isDirty(), false);
    const raw = readFileSync(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    const reloaded = loadFileStore(path);
    assert.equal(reloaded.getCaseOrThrow("case_persist").id, "case_persist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduleStorePersist skips when store is not dirty", () => {
  const store = new MemoryStore();
  assert.doesNotThrow(() => scheduleStorePersist(store, "/tmp/unused-oblivion.json"));
  assert.equal(store.isDirty(), false);
});