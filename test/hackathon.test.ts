import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentDelegationSet,
  createPaymentSession,
  validateErc7710Delegation,
  validatePermissionGrant,
  X402_PRODUCTS
} from "../src/domain/hackathon.js";
import { runVeniceAnalysis } from "../src/domain/venice.js";
import type { Erc7710Delegation, PermissionGrant } from "../src/domain/types.js";

test("payment catalog covers one-off x402 and ERC-7710 subscription tracks", () => {
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "one-off" && product.x402Endpoint));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "subscription" && product.cadence === "monthly"));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "one-off" && product.amountUsd === 5));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "subscription" && product.amountUsd === 10));
  assert.ok(X402_PRODUCTS.every((product) => product.requiredPermission === "erc7710-payment"));
});

test("ERC-7710 delegation requires expiry, cap, and narrow scope", () => {
  const session = createPaymentSession({ caseId: "case_demo", mode: "subscription" });
  assert.equal(session.erc7710Delegation.standard, "ERC-7710");
  assert.equal(session.erc7710Delegation.scope.includes("x402-only"), true);

  const broad: Erc7710Delegation = {
    ...session.erc7710Delegation,
    scope: ["*"]
  };
  assert.throws(() => validateErc7710Delegation(broad), /erc7710-scope-too-broad/);

  const uncapped: Erc7710Delegation = {
    ...session.erc7710Delegation,
    spendCapUsd: 0
  };
  assert.throws(() => validateErc7710Delegation(uncapped), /erc7710-spend-cap-invalid/);
});

test("advanced permissions reject broad agent scope", () => {
  const grant: PermissionGrant = {
    id: "permission_demo",
    caseId: "case_demo",
    permissionType: "erc7715-advanced",
    delegate: "OblivionRoot",
    scope: ["all"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    redelegatable: true,
    status: "granted",
    createdAt: new Date().toISOString()
  };
  assert.throws(() => validatePermissionGrant(grant), /permission-scope-too-broad/);
});

test("Venice adapter redacts identifiers before producing user-facing analysis", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = "test-key";
  process.env.VENICE_BASE_URL = "https://api.venice.ai/api/v1";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Classification",
                summary: "Redacted context reviewed.",
                risk: "standard",
                recommendedTask: "broker-opt-out",
                nextSteps: ["Verify path"]
              })
            }
          }
        ]
      }),
      { status: 200 }
    );
  try {
    const analysis = await runVeniceAnalysis({
      caseId: "case_demo",
      kind: "classify-case",
      notes: "Contact me at person@example.com or 212-555-1111 about my address."
    });
    const encoded = JSON.stringify(analysis);
    assert.doesNotMatch(encoded, /person@example\.com/);
    assert.doesNotMatch(encoded, /212-555-1111/);
    assert.match(analysis.redactedInputSummary, /p\*{5,}@example\.com/);
    assert.match(analysis.redactedInputSummary, /\[phone:redacted\]/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
  }
});

test("A2A redelegation keeps specialized agents narrowly scoped", () => {
  const result = createAgentDelegationSet("case_demo");
  assert.equal(result.delegations.length, 4);
  assert.ok(result.delegations.some((item) => item.toAgent === "ScoutAgent"));
  assert.ok(result.delegations.some((item) => item.toAgent === "PaymentAgent"));
  assert.ok(result.delegations.every((item) => !item.scope.includes("*")));
  assert.ok(result.messages.every((item) => item.redactedPayload.includes("raw identifiers stay")));
});
