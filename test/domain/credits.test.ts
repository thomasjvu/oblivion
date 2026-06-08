import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCreditsForEmailRelay,
  assertCreditsForTokens,
  creditWallet,
  creditsForTokens,
  debitCredits,
  getOrCreateCreditAccount,
  resolveCreditsView,
  settleCreditsForProduct,
  STARTER_PACK_CREDITS,
  MONITOR_MONTHLY_CREDITS,
  walletKeyFromAddress
} from "../../src/domain/credits.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

const WALLET = "0x1111111111111111111111111111111111111111";

test("walletKeyFromAddress hashes normalized lowercase address", () => {
  const key = walletKeyFromAddress(WALLET);
  assert.equal(key, walletKeyFromAddress(WALLET.toUpperCase()));
  assert.match(key, /^[a-f0-9]{64}$/);
});

test("settleCreditsForProduct credits starter and subscription packs", () => {
  const store = new MemoryStore();
  const starter = settleCreditsForProduct(store, WALLET, "one-off");
  assert.equal(starter.balanceCredits, STARTER_PACK_CREDITS);
  const subscription = settleCreditsForProduct(store, WALLET, "subscription");
  assert.equal(subscription.balanceCredits, STARTER_PACK_CREDITS + MONITOR_MONTHLY_CREDITS);
  assert.ok(subscription.subscriptionExpiresAt);
});

test("debitCredits enforces balance and token/email rates", () => {
  const store = new MemoryStore();
  const account = getOrCreateCreditAccount(store, WALLET);
  creditWallet(store, account.walletKey, 100, { kind: "purchase" });
  assert.equal(creditsForTokens(250), 3);
  debitCredits(store, walletKeyFromAddress(WALLET), 25, { kind: "email", caseId: "case_1" });
  const view = resolveCreditsView(store, WALLET);
  assert.equal(view.balanceCredits, 75);
  assert.throws(
    () => assertCreditsForTokens(store, WALLET, 10_000),
    (error: Error & { code?: string }) => error.code === "credits-insufficient"
  );
  creditWallet(store, walletKeyFromAddress(WALLET), 25, { kind: "purchase" });
  assert.ok(assertCreditsForEmailRelay(store, WALLET));
});