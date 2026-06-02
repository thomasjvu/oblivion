import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";

test("hackathon API flow exposes MetaMask, x402, Venice, A2A, and 1Shot demo state", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address!.port}`;

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const products = await get(base, "/api/x402/products");
    assert.ok(products.products.some((product: any) => product.mode === "one-off"));
    assert.ok(products.products.some((product: any) => product.mode === "subscription"));

    const integrations = await get(base, "/api/integrations/status");
    assert.equal(integrations.mode, "demo-adapters");

    const smart = await post(base, "/api/metamask/demo-session", {
      caseId,
      walletAddress: "0x1111111111111111111111111111111111111111"
    }, 201);
    assert.match(smart.smartAccountAddress, /^0x[a-f0-9]{40}$/);
    assert.ok(smart.permissions.some((permission: any) => permission.permissionType === "erc7715-advanced"));

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
    assert.equal(subscription.session.cadence, "weekly");

    const premium = await post(base, "/api/agent/premium-task", {
      caseId,
      paymentSessionId: oneOff.session.id
    });
    assert.equal(premium.entitlement, "demo-accepted");

    const venice = await post(base, "/api/ai/classify-case", {
      caseId,
      notes: "Remove person@example.com from a people-search site."
    }, 201);
    assert.doesNotMatch(JSON.stringify(venice), /person@example\.com/);
    assert.equal(venice.analysis.kind, "classify-case");

    const agents = await post(base, "/api/agents/delegate", { caseId }, 201);
    assert.ok(agents.delegations.some((delegation: any) => delegation.toAgent === "ScoutAgent"));

    const relay = await post(base, "/api/1shot/relay-demo", {
      caseId,
      sessionId: oneOff.session.id
    }, 201);
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
  } finally {
    server.close();
  }
});

test("agent run-next endpoint orchestrates the demo stack step by step", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address!.port}`;

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;

    const seen = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const next = await get(base, `/api/agent/next?caseId=${caseId}`);
      seen.add(next.action);
      if (next.action === "complete" || next.action === "await-user-approval") break;
      await post(base, "/api/agent/run-next", {
        caseId,
        walletAddress: "0x1111111111111111111111111111111111111111"
      });
    }

    assert.ok(seen.has("setup-smart-account"));
    assert.ok(seen.has("prepare-one-off-payment"));
    assert.ok(seen.has("prepare-subscription"));
    assert.ok(seen.has("ask-venice"));
    assert.ok(seen.has("delegate-agents"));
    assert.ok(seen.has("relay-payment"));
    assert.ok(seen.has("prepare-cleanup-approval"));

    const approvalGate = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(approvalGate.action, "await-user-approval");
    const current = await get(base, `/api/cases/${caseId}`);
    assert.equal(current.status.approvalsNeeded.length, 1);

    const approval = current.status.approvalsNeeded[0];
    await post(base, `/api/approvals/${approval.id}/approve`, {
      userConfirmation: "I approve this exact action"
    });
    const afterApproval = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(afterApproval.action, "record-approved-action");
    await post(base, "/api/agent/run-next", { caseId });
    const finalNext = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(finalNext.action, "complete");
    const checklist = await get(base, `/api/hackathon/status?caseId=${caseId}`);
    assert.equal(Object.values(checklist.status).filter(Boolean).length, 8);
  } finally {
    server.close();
  }
});

async function get(base: string, path: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}

async function post(base: string, path: string, body: unknown, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}
