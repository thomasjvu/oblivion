import assert from "node:assert/strict";
import test from "node:test";
import {
  claimPaymentSessionForSettlement,
  settleCreditProduct
} from "../../src/domain/payments/settlement.js";
import { DomainError } from "../../src/domain/errors.js";
import type { CaseRecord, PaymentSession } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedCase(store: MemoryStore): CaseRecord {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_payment_test",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_payment_test",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  return caseRecord;
}

function seedSession(caseId: string): PaymentSession {
  const now = new Date().toISOString();
  return {
    id: "payment_test_session",
    caseId,
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
      cadence: undefined,
      expiresAt: now,
      scope: ["top-up-credits"]
    },
    walletKey: "wallet_test",
    walletAddress: "0x1234567890123456789012345678901234567890",
    createdAt: now,
    updatedAt: now
  };
}

test("settleCreditProduct rejects unpaid session without bypass", () => {
  const originalBypass = process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.OBLIVION_CREDITS_BYPASS;
  try {
    const store = new MemoryStore();
    const caseRecord = seedCase(store);
    const session = seedSession(caseRecord.id);
    store.paymentSessions.set(session.id, session);
    const settled = settleCreditProduct(store, caseRecord, {
      walletAddress: session.walletAddress!,
      expectedMode: "one-off",
      paymentSessionId: session.id
    });
    assert.equal(settled, null);
  } finally {
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
  }
});

test("settleCreditProduct is idempotent when session already paid", () => {
  const originalBypass = process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.OBLIVION_CREDITS_BYPASS;
  try {
    const store = new MemoryStore();
    const caseRecord = seedCase(store);
    const session = seedSession(caseRecord.id);
    store.paymentSessions.set(session.id, session);
    const first = settleCreditProduct(store, caseRecord, {
      walletAddress: session.walletAddress!,
      expectedMode: "one-off",
      paymentSessionId: session.id,
      settlementTransaction: "0xabc123"
    });
    assert.ok(first);
    const ledgerAfterFirst = store.creditLedger.size;
    const second = settleCreditProduct(store, caseRecord, {
      walletAddress: session.walletAddress!,
      expectedMode: "one-off",
      paymentSessionId: session.id,
      settlementTransaction: "0xabc123"
    });
    assert.ok(second);
    assert.equal(store.creditLedger.size, ledgerAfterFirst);
    assert.equal(second?.balanceCredits, first?.balanceCredits);
  } finally {
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
  }
});

test("claimPaymentSessionForSettlement allows only one credit grant", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const session = seedSession(caseRecord.id);
  store.paymentSessions.set(session.id, session);
  const first = claimPaymentSessionForSettlement(store, session.id, "0xabc123");
  const second = claimPaymentSessionForSettlement(store, session.id, "0xabc123");
  assert.notEqual(first, "already-paid");
  assert.equal(second, "already-paid");
});

test("settleCreditProduct rejects ambiguous sessions without paymentSessionId", () => {
  const store = new MemoryStore();
  const caseRecord = seedCase(store);
  const sessionA = seedSession(caseRecord.id);
  const sessionB = { ...seedSession(caseRecord.id), id: "payment_session_b" };
  store.paymentSessions.set(sessionA.id, sessionA);
  store.paymentSessions.set(sessionB.id, sessionB);
  assert.throws(
    () =>
      settleCreditProduct(store, caseRecord, {
        walletAddress: sessionA.walletAddress!,
        expectedMode: "one-off",
        settlementTransaction: "0xabc123"
      }),
    (error: unknown) => error instanceof DomainError && error.code === "payment-session-ambiguous"
  );
});

test("settleCreditProduct accepts settlement transaction", () => {
  const originalBypass = process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.OBLIVION_CREDITS_BYPASS;
  try {
    const store = new MemoryStore();
    const caseRecord = seedCase(store);
    const session = seedSession(caseRecord.id);
    store.paymentSessions.set(session.id, session);
    const settled = settleCreditProduct(store, caseRecord, {
      walletAddress: session.walletAddress!,
      expectedMode: "one-off",
      paymentSessionId: session.id,
      settlementTransaction: "0xabc123"
    });
    assert.ok(settled);
    assert.equal(settled?.session.status, "paid");
  } finally {
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
  }
});