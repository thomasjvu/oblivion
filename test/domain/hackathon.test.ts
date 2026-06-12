import test from "node:test";
import assert from "node:assert/strict";
import { X402_PRODUCTS } from "../../src/domain/payments/catalog.js";
import { createPaymentSession } from "../../src/domain/payments/sessions.js";

const WALLET = "0x1111111111111111111111111111111111111111";

test("payment catalog covers one-off x402 and ERC-7710 subscription tracks", () => {
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "one-off" && product.x402Endpoint));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "subscription" && product.cadence === "monthly"));
  assert.ok(X402_PRODUCTS.every((product) => product.requiredPermission === "erc7710-payment"));
});

test("createPaymentSession fails when x402 is not configured", () => {
  const priorPayTo = process.env.X402_PAY_TO;
  try {
    delete process.env.X402_PAY_TO;
    assert.throws(
      () => createPaymentSession({ caseId: "case_demo", mode: "one-off", walletAddress: WALLET }),
      /X402_PAY_TO/
    );
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
  }
});