import assert from "node:assert/strict";
import test from "node:test";
import { clearAttestationCacheForTests } from "../../src/domain/attestation.js";
import { runLiveConnector } from "../../src/domain/connectorRuntime.js";
import type { ActionRequest, Approval } from "../../src/domain/types.js";

const trustConfig = {
  deploymentVersion: "0.1.0",
  sourceCommit: "test",
  expectedComposeHash: "replace-me",
  imageDigests: ["ghcr.io/example/oblivion@sha256:" + "a".repeat(64)],
  verificationInstructions: []
};

function seedAction(): { approval: Approval; action: ActionRequest } {
  const now = new Date().toISOString();
  const approval: Approval = {
    id: "approval_live",
    caseId: "case_live",
    actionType: "pwned-password-range-check",
    destination: "HIBP",
    identifiersApproved: ["email"],
    dataToDisclose: ["password"],
    purpose: "Breach check",
    disclosureRisk: "k-anonymity prefix only",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "approved",
    createdAt: now
  };
  const action: ActionRequest = {
    id: "action_live",
    caseId: "case_live",
    actionType: "pwned-password-range-check",
    destination: "HIBP",
    template: "hibp-password-range",
    draftText: "Draft",
    deadlineBasis: "immediate",
    expectedConfirmationStep: "None",
    approvalId: approval.id,
    executionStatus: "ready",
    createdAt: now
  };
  return { approval, action };
}

test("runLiveConnector fetches HIBP password range with approved handoff prefix", async () => {
  clearAttestationCacheForTests();
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://api.pwnedpasswords.com/range/")) {
      requestedUrl = target;
      return new Response("ABCDEF:12\r\n", { status: 200 });
    }
    if (target.includes("attestation.local")) {
      return Response.json({
        intel_quote: Buffer.from("fake").toString("base64"),
        info: { tcb_info: { app_compose: "{}" } }
      });
    }
    if (init?.method === "POST") {
      return Response.json({ quote: { verified: true } });
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const { approval, action } = seedAction();
    const output = await runLiveConnector({
      action,
      approval,
      trustCenterConfig: {
        ...trustConfig,
        attestationReportUrl: "https://attestation.local/report",
        expectedComposeHash: "f".repeat(64)
      },
      handoff: { hashPrefix: "abc12" }
    });

    assert.equal(requestedUrl, "https://api.pwnedpasswords.com/range/ABC12");
    assert.equal(output.result.status, "ready");
    assert.deepEqual(output.transmitted, ["hashPrefix"]);
    assert.deepEqual(output.neverTransmit, ["password"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});