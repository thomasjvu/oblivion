import test from "node:test";
import assert from "node:assert/strict";
import { assertAiBudget, resolveAiEntitlement } from "../../src/domain/aiBudget.js";
import { creditWallet, getOrCreateCreditAccount, walletKeyFromAddress } from "../../src/domain/credits.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

const WALLET = "0x2222222222222222222222222222222222222222";

test("assertAiBudget requires wallet credits", () => {
  const store = new MemoryStore();
  assert.throws(
    () => assertAiBudget(store, WALLET, "chat"),
    (error: Error & { code?: string }) => error.code === "credits-insufficient"
  );
});

test("credited wallet unlocks AI entitlement view", () => {
  const store = new MemoryStore();
  getOrCreateCreditAccount(store, WALLET);
  creditWallet(store, walletKeyFromAddress(WALLET), 500, { kind: "purchase" });
  const entitlement = assertAiBudget(store, WALLET, "chat");
  assert.equal(entitlement.balanceCredits, 500);
  assert.ok(entitlement.maxTokens >= 280);
});

test("resolveAiEntitlement returns zero balance without wallet", () => {
  const store = new MemoryStore();
  const view = resolveAiEntitlement(store);
  assert.equal(view.balanceCredits, 0);
});