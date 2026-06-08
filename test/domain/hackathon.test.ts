import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHackathonStatus,
  createAgentDelegationSet,
  createPaymentSession,
  demoSmartAccountAddress,
  pendingHackathonTracks,
  resolveSmartAccountAddress,
  validateErc7710Delegation,
  validatePermissionGrant,
  X402_PRODUCTS
} from "../../src/domain/hackathon.js";
import { runVeniceAnalysis } from "../../src/domain/venice.js";
import type { Erc7710Delegation, PermissionGrant } from "../../src/domain/types.js";

const WALLET = "0x1111111111111111111111111111111111111111";

test("resolveSmartAccountAddress uses wallet in live mode and hash in demo", () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  assert.equal(
    resolveSmartAccountAddress({ walletAddress: wallet, mode: "live" }),
    wallet
  );
  assert.equal(
    resolveSmartAccountAddress({ walletAddress: wallet, mode: "demo" }),
    demoSmartAccountAddress(wallet)
  );
  assert.equal(
    resolveSmartAccountAddress({
      walletAddress: wallet,
      mode: "live",
      smartAccountAddress: "0x2222222222222222222222222222222222222222"
    }),
    "0x2222222222222222222222222222222222222222"
  );
});

test("createPaymentSession uses x402-v2 when live x402 is configured", () => {
  const priorPayTo = process.env.X402_PAY_TO;
  const priorEnabled = process.env.X402_ENABLED;
  try {
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    process.env.X402_ENABLED = "true";
    const session = createPaymentSession({ caseId: "case_x402", mode: "one-off", walletAddress: WALLET });
    assert.equal(session.x402Request.version, "x402-v2");
    assert.match(session.x402Request.network, /^eip155:/);
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
    if (priorEnabled === undefined) delete process.env.X402_ENABLED;
    else process.env.X402_ENABLED = priorEnabled;
  }
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

test("payment catalog covers one-off x402 and ERC-7710 subscription tracks", () => {
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "one-off" && product.x402Endpoint));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "subscription" && product.cadence === "monthly"));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "one-off" && product.amountUsd === 5));
  assert.ok(X402_PRODUCTS.some((product) => product.mode === "subscription" && product.amountUsd === 10));
  assert.ok(X402_PRODUCTS.every((product) => product.requiredPermission === "erc7710-payment"));
});

test("ERC-7710 delegation requires expiry, cap, and narrow scope", () => {
  const priorPayTo = process.env.X402_PAY_TO;
  try {
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    const session = createPaymentSession({ caseId: "case_demo", mode: "subscription", walletAddress: WALLET });
    assert.equal(session.erc7710Delegation.standard, "ERC-7710");
    assert.equal(session.erc7710Delegation.scope.includes("x402-only"), true);
    assert.equal(session.erc7710Delegation.scope.includes("wallet-bound"), true);

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
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
  }
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

test("oneShotRelayerVisible requires a non-checklist confirmed relayer event", () => {
  const checklistOnly = buildHackathonStatus({
    caseId: "case_demo",
    permissions: [],
    payments: [],
    veniceAnalyses: [],
    delegations: [],
    relayerEvents: [
      {
        id: "relayer_checklist",
        caseId: "case_demo",
        provider: "1shot",
        eventType: "confirmed",
        status: "confirmed",
        message: "checklist placeholder",
        payload: { checklistOnly: true },
        createdAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(checklistOnly.oneShotRelayerVisible, false);

  const liveRelay = buildHackathonStatus({
    caseId: "case_demo",
    permissions: [],
    payments: [],
    veniceAnalyses: [],
    delegations: [],
    relayerEvents: [
      {
        id: "relayer_live",
        caseId: "case_demo",
        provider: "1shot",
        eventType: "confirmed",
        status: "confirmed",
        message: "live relay confirmed",
        createdAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(liveRelay.oneShotRelayerVisible, true);
});

test("pendingHackathonTracks includes ERC-7710 subscription until prepared", () => {
  const empty = buildHackathonStatus({
    caseId: "case_demo",
    permissions: [],
    payments: [],
    veniceAnalyses: [],
    delegations: [],
    relayerEvents: []
  });
  assert.deepEqual(pendingHackathonTracks(empty), ["x402", "erc7710", "venice", "a2a", "1shot"]);
  const priorPayTo = process.env.X402_PAY_TO;
  try {
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    const oneOff = buildHackathonStatus({
      caseId: "case_demo",
      permissions: [],
      payments: [createPaymentSession({ caseId: "case_demo", mode: "one-off", walletAddress: WALLET })],
      veniceAnalyses: [],
      delegations: [],
      relayerEvents: []
    });
    assert.deepEqual(pendingHackathonTracks(oneOff), ["erc7710", "venice", "a2a", "1shot"]);
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
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
