import test from "node:test";
import assert from "node:assert/strict";
import { activateTestCase, encryptedBlob, get, post, startTestServer } from "../helpers/http.js";

const originalFetch = globalThis.fetch;
const originalVeniceKey = process.env.VENICE_API_KEY;
const originalVeniceBase = process.env.VENICE_BASE_URL;
const originalOneShotKey = process.env.ONESHOT_API_KEY;
const originalPayTo = process.env.X402_PAY_TO;
const originalApiUrl = process.env.OBLIVION_PUBLIC_API_URL;

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
    if (String(url).includes("relayer.test")) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { status: "Confirmed", txHash: "0xabc", userOpHash: "0xdef" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, init);
  };
}

function enableLiveIntegrations() {
  process.env.HACKATHON_MODE = "true";
  process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  process.env.ONESHOT_API_KEY = "test-key";
  process.env.ONESHOT_BASE_URL = "https://relayer.test/relayers";
  process.env.OBLIVION_PUBLIC_API_URL = "https://api.example.com";
  process.env.OBLIVION_AI_BYPASS_PAYMENT = "true";
}

function enableHackathonTracksWithoutOneShot() {
  process.env.HACKATHON_MODE = "true";
  process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  process.env.OBLIVION_PUBLIC_API_URL = "https://api.example.com";
  process.env.OBLIVION_AI_BYPASS_PAYMENT = "true";
  delete process.env.ONESHOT_API_KEY;
}

const originalHackathonMode = process.env.HACKATHON_MODE;

function restoreEnv() {
  globalThis.fetch = originalFetch;
  if (originalHackathonMode === undefined) delete process.env.HACKATHON_MODE;
  else process.env.HACKATHON_MODE = originalHackathonMode;
  if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = originalVeniceKey;
  if (originalVeniceBase === undefined) delete process.env.VENICE_BASE_URL;
  else process.env.VENICE_BASE_URL = originalVeniceBase;
  if (originalOneShotKey === undefined) delete process.env.ONESHOT_API_KEY;
  else process.env.ONESHOT_API_KEY = originalOneShotKey;
  if (originalPayTo === undefined) delete process.env.X402_PAY_TO;
  else process.env.X402_PAY_TO = originalPayTo;
  if (originalApiUrl === undefined) delete process.env.OBLIVION_PUBLIC_API_URL;
  else process.env.OBLIVION_PUBLIC_API_URL = originalApiUrl;
}

test("hackathon API flow exposes MetaMask, x402, Venice, A2A, and live 1Shot polling", async () => {
  installVeniceMock();
  enableLiveIntegrations();
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const products = await get(base, "/api/x402/products");
    assert.ok(products.products.some((product: { mode: string }) => product.mode === "one-off"));

    const integrations = await get(base, "/api/integrations/status");
    assert.equal(integrations.liveReady.venice, true);
    assert.equal(integrations.liveReady.oneShot, true);

    const smart = await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x1111111111111111111111111111111111111111"
    }, 201);

    const oneOff = await post(base, "/api/x402/one-off", {
      caseId,
      productId: "credit-starter",
      walletAddress: "0x1111111111111111111111111111111111111111",
      smartAccountAddress: smart.smartAccountAddress
    }, 201);
    assert.equal(oneOff.session.mode, "one-off");
    assert.equal(oneOff.session.x402Request.version, "x402-v2");

    const venice = await post(base, "/api/ai/classify-case", {
      caseId,
      walletAddress: "0x1111111111111111111111111111111111111111",
      notes: "Remove person@example.com from a people-search site."
    }, 201);
    assert.doesNotMatch(JSON.stringify(venice), /person@example\.com/);

    const agents = await post(base, "/api/agents/delegate", { caseId }, 201);
    assert.ok(agents.delegations.some((delegation: { toAgent: string }) => delegation.toAgent === "ScoutAgent"));

    const relay = await post(base, "/api/1shot/relay", {
      caseId,
      sessionId: oneOff.session.id,
      taskId: "task_123"
    }, 201);
    assert.equal(relay.events.at(-1).status, "confirmed");

    const webhook = await post(
      base,
      `/api/1shot/webhook?caseId=${caseId}&sessionId=${oneOff.session.id}`,
      {
        eventName: "TransactionExecutionSuccess",
        data: {
          transactionExecutionId: "task_webhook",
          transactionReceipt: { hash: "0xfeed", status: 1 }
        }
      },
      202
    );
    assert.equal(webhook.event.status, "confirmed");

    const checklist = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.equal(checklist.status.oneShotRelayerVisible, true);
    assert.equal(checklist.status.veniceOutputReady, true);
    assert.equal(checklist.status.a2aRedelegationVisible, true);
  } finally {
    server.close();
    restoreEnv();
  }
});

test("complete-pending only finishes configured integration tracks", async () => {
  installVeniceMock();
  enableHackathonTracksWithoutOneShot();
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x3333333333333333333333333333333333333333"
    }, 201);

    const before = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.ok(before.pending.includes("x402"));
    assert.ok(before.pending.includes("1shot"));

    const finished = await post(base, "/api/hackathon/complete-pending", {
      caseId,
      walletAddress: "0x3333333333333333333333333333333333333333",
      notes: "Remove person@example.com from people-search."
    }, 201);
    assert.ok(finished.completed.includes("x402"));
    assert.ok(finished.completed.includes("venice"));
    assert.ok(finished.completed.includes("a2a"));
    assert.equal(finished.completed.includes("1shot"), false);
    assert.equal(finished.status.oneShotRelayerVisible, false);
    assert.doesNotMatch(JSON.stringify(finished), /person@example\.com/);
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("complete-pending does not fake 1shot relay completion", async () => {
  installVeniceMock();
  enableLiveIntegrations();
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const finished = await post(base, "/api/hackathon/complete-pending", {
      caseId,
      notes: "Remove person@example.com from people-search."
    }, 201);
    assert.equal(finished.completed.includes("1shot"), false);
    assert.equal(finished.status.oneShotRelayerVisible, false);
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("agent run-next endpoint now requires a cleanup preset and advances the cleanup plan", async () => {
  delete process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.OBLIVION_AI_BYPASS_PAYMENT;
  delete process.env.HACKATHON_MODE;
  const { server, base, store } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const nextWithoutPreset = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(nextWithoutPreset.action, "select-preset");
    await post(base, "/api/agent/run-next", { caseId }, 402);

    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: encryptedBlob(caseId),
      redactedScope: {
        personLabel: "Case A",
        aliases: [],
        approvedIdentifierLabels: ["email"],
        sensitiveConstraints: []
      }
    });

    activateTestCase(store, caseId);
    await post(base, "/api/agent/run-next", { caseId }, 409);
    await post(base, `/api/cases/${caseId}/preset`, { presetId: "people-search-cleanup" }, 201);
    const run = await post(base, `/api/cases/${caseId}/agent/run`, {}, 200);
    assert.ok(run.plan);
    assert.ok(run.next);
  } finally {
    server.close();
  }
});