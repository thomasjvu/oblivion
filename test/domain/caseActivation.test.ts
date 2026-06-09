import test from "node:test";
import assert from "node:assert/strict";
import {
  activateCaseForTest,
  activationBypassEnabled,
  assertCaseActivated,
  isCaseActivated
} from "../../src/domain/caseActivation.js";
import { createCaseRecord } from "../../src/domain/cases.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("unpaid consumer case is not activated", () => {
  const store = new MemoryStore();
  const { caseRecord } = createCaseRecord({ jurisdiction: "US", authorityBasis: "self" });
  store.cases.set(caseRecord.id, caseRecord);
  assert.equal(isCaseActivated(store, caseRecord.id), activationBypassEnabled());
  if (!activationBypassEnabled()) {
    assert.throws(() => assertCaseActivated(store, caseRecord), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 402);
      assert.equal(error.message, "case-activation-required");
      return true;
    });
  }
});

test("paid session activates consumer case", () => {
  const store = new MemoryStore();
  const { caseRecord } = createCaseRecord({ jurisdiction: "US", authorityBasis: "self" });
  store.cases.set(caseRecord.id, caseRecord);
  activateCaseForTest(store, caseRecord.id);
  assert.equal(isCaseActivated(store, caseRecord.id), true);
  assert.doesNotThrow(() => assertCaseActivated(store, caseRecord));
  const updated = store.cases.get(caseRecord.id);
  assert.ok(updated?.activatedAt);
  assert.ok(updated?.activatedWalletKey);
});

test("partner cases skip activation gate", () => {
  const store = new MemoryStore();
  const { caseRecord } = createCaseRecord({
    jurisdiction: "US",
    authorityBasis: "self",
    partnerId: "partner_demo"
  });
  store.cases.set(caseRecord.id, caseRecord);
  assert.equal(isCaseActivated(store, caseRecord.id), true);
  assert.doesNotThrow(() => assertCaseActivated(store, caseRecord));
});