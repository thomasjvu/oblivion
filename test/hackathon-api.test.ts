import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";

const originalFetch = globalThis.fetch;
const originalVeniceKey = process.env.VENICE_API_KEY;
const originalVeniceBase = process.env.VENICE_BASE_URL;
const originalOneShotKey = process.env.ONESHOT_API_KEY;
const originalOneShotDemo = process.env.ONESHOT_DEMO_FALLBACK;

function installVeniceMock() {
  process.env.VENICE_API_KEY = "test-key";
  process.env.VENICE_BASE_URL = "https://api.venice.ai/api/v1";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.venice.ai")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const kind = body.messages?.[1]?.content?.includes("draft-request")
        ? "draft-request"
        : body.messages?.[1]?.content?.includes("review-approval")
          ? "review-approval"
          : "classify-case";
      const payload =
        kind === "draft-request"
          ? {
              title: "Removal request draft",
              summary: "Draft from Venice.",
              recommendedTask: "broker-opt-out",
              draftText: "Please remove the approved profile.",
              nextSteps: ["Review", "Approve"]
            }
          : kind === "review-approval"
            ? {
                title: "Approval review",
                summary: "Scope looks narrow.",
                recommendedTask: "broker-opt-out",
                approvalExplanation: "Only approved categories.",
                nextSteps: ["Approve"]
              }
            : {
                title: "Redacted case classification",
                summary: "People-search cleanup route fits.",
                risk: "standard",
                recommendedTask: "broker-opt-out",
                nextSteps: ["Verify path"]
              };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, init);
  };
}

test("hackathon API flow exposes MetaMask, x402, Venice, A2A, and 1Shot demo state", async () => {
  installVeniceMock();
  process.env.ONESHOT_API_KEY = "test-key";
  process.env.ONESHOT_DEMO_FALLBACK = "true";
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const products = await get(base, "/api/x402/products");
    assert.ok(products.products.some((product: { mode: string }) => product.mode === "one-off"));
    assert.ok(products.products.some((product: { mode: string }) => product.mode === "subscription"));

    const integrations = await get(base, "/api/integrations/status");
    assert.equal(integrations.liveReady.venice, true);
    assert.equal(integrations.liveReady.oneShot, false);

    const smart = await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x1111111111111111111111111111111111111111"
    }, 201);
    assert.equal(smart.mode, "demo");
    assert.match(smart.smartAccountAddress, /^0x[a-f0-9]{40}$/);

    const smartLive = await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x2222222222222222222222222222222222222222",
      mode: "live",
      txHash: "0xabc123",
      callsId: "0xbatch1",
      chainId: 11155111
    }, 201);
    assert.equal(smartLive.mode, "live");
    assert.equal(smartLive.txHash, "0xabc123");
    assert.ok(smart.permissions.some((permission: { permissionType: string }) => permission.permissionType === "erc7715-advanced"));

    const oneOff = await post(base, "/api/x402/one-off", {
      caseId,
      productId: "broker-opt-out-packet",
      smartAccountAddress: smart.smartAccountAddress
    }, 201);
    assert.equal(oneOff.session.mode, "one-off");
    assert.equal(oneOff.permission.permissionType, "erc7710-payment");

    const subscription = await post(base, "/api/x402/subscription", {
      caseId,
      productId: "weekly-monitor",
      smartAccountAddress: smart.smartAccountAddress
    }, 201);
    assert.equal(subscription.session.cadence, "monthly");

    const premium = await post(base, "/api/agent/premium-task", {
      caseId,
      paymentSessionId: oneOff.session.id
    });
    assert.equal(premium.entitlement, "payment-session-verified");

    const venice = await post(base, "/api/ai/classify-case", {
      caseId,
      notes: "Remove person@example.com from a people-search site."
    }, 201);
    assert.doesNotMatch(JSON.stringify(venice), /person@example\.com/);
    assert.equal(venice.analysis.kind, "classify-case");
    assert.match(venice.analysis.model, /glm|venice/i);

    const agents = await post(base, "/api/agents/delegate", { caseId }, 201);
    assert.ok(agents.delegations.some((delegation: { toAgent: string }) => delegation.toAgent === "ScoutAgent"));

    const relay = await post(base, "/api/1shot/relay-demo", {
      caseId,
      sessionId: oneOff.session.id
    }, 201);
    assert.equal(relay.mode, "demo");
    assert.equal(relay.events.at(-1).status, "confirmed");

    const timeline = await get(base, `/api/agents/timeline?caseId=${caseId}`);
    assert.ok(timeline.payments.length >= 2);
    assert.ok(timeline.veniceAnalyses.length >= 1);
    assert.ok(timeline.relayerEvents.length >= 3);

    const checklist = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.deepEqual(checklist.status, {
      caseId,
      smartAccountVisible: true,
      erc7715PermissionGranted: true,
      x402OneOffReady: true,
      erc7710SubscriptionReady: true,
      veniceOutputReady: true,
      a2aRedelegationVisible: true,
      oneShotRelayerVisible: true
    });
    assert.deepEqual(checklist.pending, []);
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
    if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalVeniceKey;
    if (originalVeniceBase === undefined) delete process.env.VENICE_BASE_URL;
    else process.env.VENICE_BASE_URL = originalVeniceBase;
    if (originalOneShotKey === undefined) delete process.env.ONESHOT_API_KEY;
    else process.env.ONESHOT_API_KEY = originalOneShotKey;
    if (originalOneShotDemo === undefined) delete process.env.ONESHOT_DEMO_FALLBACK;
    else process.env.ONESHOT_DEMO_FALLBACK = originalOneShotDemo;
  }
});

test("complete-pending finishes x402, Venice, A2A, and 1Shot tracks from wallet-ready state", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const smart = await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x3333333333333333333333333333333333333333"
    }, 201);

    await post(base, "/api/x402/subscription", {
      caseId,
      productId: "weekly-monitor",
      smartAccountAddress: smart.smartAccountAddress
    }, 201);

    const before = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.deepEqual(before.pending, ["x402", "venice", "a2a", "1shot"]);

    const finished = await post(base, "/api/hackathon/complete-pending", {
      caseId,
      walletAddress: "0x3333333333333333333333333333333333333333",
      smartAccountAddress: smart.smartAccountAddress,
      notes: "Remove person@example.com from people-search."
    }, 201);
    assert.deepEqual(finished.completed, ["x402", "venice", "a2a", "1shot"]);
    assert.equal(finished.status.x402OneOffReady, true);
    assert.equal(finished.status.erc7710SubscriptionReady, true);
    assert.equal(finished.status.veniceOutputReady, true);
    assert.equal(finished.status.a2aRedelegationVisible, true);
    assert.equal(finished.status.oneShotRelayerVisible, true);
    assert.doesNotMatch(JSON.stringify(finished), /person@example\.com/);

    const after = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.deepEqual(after.pending, []);
  } finally {
    server.close();
  }
});

test("agent run-next endpoint now requires a cleanup preset and advances the cleanup plan", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const nextWithoutPreset = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(nextWithoutPreset.action, "select-preset");
    await post(base, "/api/agent/run-next", { caseId }, 409);

    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: encryptedBlob(caseId),
      redactedScope: {
        personLabel: "Case A",
        aliases: [],
        approvedIdentifierLabels: ["email"],
        sensitiveConstraints: []
      }
    });

    await post(base, `/api/cases/${caseId}/preset`, { presetId: "people-search-cleanup" }, 201);
    const run = await post(base, `/api/cases/${caseId}/agent/run`, {}, 200);
    assert.ok(run.plan);
    assert.ok(run.next);
  } finally {
    server.close();
  }
});

async function get(base: string, path: string) {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  if (!response.ok) throw json;
  return json;
}

function encryptedBlob(aad: string) {
  return {
    alg: "AES-256-GCM",
    keyId: "test-key",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "BBBBBBBBBBBBBBBB",
    aad
  };
}

async function post(base: string, path: string, body: unknown, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json));
  return json;
}