import test from "node:test";
import assert from "node:assert/strict";
import { markSessionPaid, x402PublicConfig } from "../../src/domain/x402.js";
import type { PaymentSession } from "../../src/domain/types.js";

function sampleSession(): PaymentSession {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    id: "pay_1",
    caseId: "case_1",
    productId: "credit-starter",
    mode: "one-off",
    status: "payment-required",
    amountUsd: 1,
    token: "USDC",
    network: "base",
    walletAddress: "0xabc",
    createdAt: now,
    updatedAt: now,
    x402Request: {
      version: "x402-v2",
      endpoint: "/api/x402/one-off",
      memo: "credit-starter",
      amountUsd: 1,
      token: "USDC",
      network: "base",
      expiresAt
    },
    erc7710Delegation: {
      standard: "ERC-7710",
      delegate: "0xdelegate",
      endpoint: "/api/x402/one-off",
      spendCapUsd: 1,
      token: "USDC",
      expiresAt,
      scope: ["credit-starter"]
    }
  };
}

test("markSessionPaid sets status paid and appends settlement memo", () => {
  const session = sampleSession();
  const paid = markSessionPaid(session, "0xdeadbeef1234567890");
  assert.equal(paid.status, "paid");
  assert.match(paid.x402Request.memo, /settled 0xdeadbeef/i);
  assert.ok(paid.updatedAt >= session.updatedAt);
});

test("x402PublicConfig reports disabled when X402_PAY_TO unset", () => {
  const previous = process.env.X402_PAY_TO;
  delete process.env.X402_PAY_TO;
  try {
    const config = x402PublicConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.payTo, undefined);
    assert.equal(config.protocolVersion, "x402-v2");
  } finally {
    if (previous) process.env.X402_PAY_TO = previous;
  }
});