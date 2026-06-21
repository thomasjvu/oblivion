import assert from "node:assert/strict";
import test from "node:test";
import { settleCreditProduct } from "../../src/domain/payments/settlement.js";
import type { CaseRecord, PaymentSession } from "../../src/domain/types.js";
import { authorizedWalletAddresses, requireBillingWalletAddress } from "../../src/domain/walletCases.js";
import { DomainError } from "../../src/domain/errors.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedCase(store: MemoryStore): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_billing",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_billing",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

test("requireBillingWalletAddress rejects unauthorized wallet", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const now = new Date().toISOString();
  const session: PaymentSession = {
    id: "payment_1",
    caseId: caseRecord.id,
    productId: "credit-starter",
    mode: "one-off",
    status: "paid",
    amountUsd: 5,
    token: "USDC",
    network: "eip155:84532",
    x402Request: {
      version: "x402-v2",
      endpoint: "/api/credits/purchase",
      amountUsd: 5,
      token: "USDC",
      network: "eip155:84532",
      memo: "test",
      expiresAt: now
    },
    erc7710Delegation: {
      standard: "ERC-7710",
      delegate: "PaymentAgent",
      endpoint: "/api/credits/purchase",
      spendCapUsd: 5,
      token: "USDC",
      expiresAt: now,
      scope: ["top-up-credits"]
    },
    walletKey: "abc",
    walletAddress: "0x1111111111111111111111111111111111111111",
    createdAt: now,
    updatedAt: now
  };
  store.paymentSessions.set(session.id, session);
  assert.throws(
    () =>
      requireBillingWalletAddress(
        store,
        caseRecord,
        "0x2222222222222222222222222222222222222222"
      ),
    (error: unknown) => error instanceof DomainError && error.code === "wallet-not-authorized-for-case"
  );
});

test("settleCreditProduct rejects wallet mismatch with session", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const now = new Date().toISOString();
  const session: PaymentSession = {
    id: "payment_mismatch",
    caseId: caseRecord.id,
    productId: "credit-starter",
    mode: "one-off",
    status: "payment-required",
    amountUsd: 5,
    token: "USDC",
    network: "eip155:84532",
    x402Request: {
      version: "x402-v2",
      endpoint: "/api/credits/purchase",
      amountUsd: 5,
      token: "USDC",
      network: "eip155:84532",
      memo: "test",
      expiresAt: now
    },
    erc7710Delegation: {
      standard: "ERC-7710",
      delegate: "PaymentAgent",
      endpoint: "/api/credits/purchase",
      spendCapUsd: 5,
      token: "USDC",
      expiresAt: now,
      scope: ["top-up-credits"]
    },
    walletAddress: "0x1111111111111111111111111111111111111111",
    walletKey: "wallet_a",
    createdAt: now,
    updatedAt: now
  };
  store.paymentSessions.set(session.id, session);
  const settled = settleCreditProduct(store, caseRecord, {
    walletAddress: "0x2222222222222222222222222222222222222222",
    expectedMode: "one-off",
    paymentSessionId: session.id,
    settlementTransaction: "0xabc"
  });
  assert.equal(settled, null);
});

test("authorizedWalletAddresses includes linked wallet", () => {
  const store = new MemoryStore();
  const caseRecord = {
    ...seedCase(store),
    linkedWalletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  };
  store.cases.set(caseRecord.id, caseRecord);
  const addresses = authorizedWalletAddresses(store, caseRecord);
  assert.ok(addresses.includes("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"));
});