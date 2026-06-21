import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { clearAttestationCacheForTests } from "../../src/domain/attestation.js";
import { runLiveConnector } from "../../src/domain/connectorRuntime.js";
import type { ActionRequest, Approval } from "../../src/domain/types.js";

const appCompose = JSON.stringify({ docker_compose_file: "services:\n  oblivion:\n    image: x@sha256:y" });
const expectedComposeHash = createHash("sha256").update(appCompose).digest("hex");
const attestationReport = {
  intel_quote: Buffer.from("fake-quote").toString("base64"),
  info: { tcb_info: { app_compose: appCompose } }
};

function teeTrustConfig() {
  return {
    deploymentVersion: "0.1.0",
    sourceCommit: "test",
    expectedComposeHash,
    imageDigests: ["ghcr.io/example/oblivion@sha256:" + "a".repeat(64)],
    attestationReportUrl: "https://attestation.local/report",
    verificationInstructions: []
  };
}

function seedBrokerOptOut(brokerId: string): { approval: Approval; action: ActionRequest } {
  const now = new Date().toISOString();
  const approval: Approval = {
    id: "approval_broker",
    caseId: "case_broker",
    actionType: "broker-opt-out",
    destination: "Spokeo",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove listing",
    disclosureRisk: "Broker disclosure",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "approved",
    createdAt: now
  };
  const action: ActionRequest = {
    id: "action_broker",
    caseId: "case_broker",
    actionType: "broker-opt-out",
    destination: "Spokeo",
    brokerId,
    template: "broker-opt-out",
    draftText: "Draft",
    deadlineBasis: "broker-response-window",
    expectedConfirmationStep: "Confirm",
    approvalId: approval.id,
    executionStatus: "ready",
    createdAt: now
  };
  return { approval, action };
}

test("runLiveConnector maps spokeo web-form opt-out with reachable official URL", async () => {
  clearAttestationCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("spokeo.com")) {
      return new Response("<html><form action='/opt-out'><input name='url'/></form></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (target.includes("attestation.local")) {
      return Response.json(attestationReport);
    }
    if (init?.method === "POST") {
      return Response.json({ quote: { verified: true } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const { approval, action } = seedBrokerOptOut("spokeo");
    const output = await runLiveConnector({
      action,
      approval,
      trustCenterConfig: teeTrustConfig(),
      handoff: { sourceUrl: "https://www.spokeo.com/jane-doe" }
    });

    assert.equal(output.result.connectorId, "broker-opt-out-live");
    assert.equal(output.result.status, "recorded");
    assert.match(output.executionRecord, /spokeo/);
    assert.deepEqual(output.neverTransmit, ["ssn", "password", "government-id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runLiveConnector requires handoff sourceUrl for web-form brokers", async () => {
  clearAttestationCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("attestation.local")) {
      return Response.json(attestationReport);
    }
    if (init?.method === "POST") {
      return Response.json({ quote: { verified: true } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const { approval, action } = seedBrokerOptOut("spokeo");
    const output = await runLiveConnector({
      action,
      approval,
      trustCenterConfig: teeTrustConfig()
    });
    assert.match(output.executionRecord, /handoff/);
    assert.equal(output.result.requiresUserHandoff, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});