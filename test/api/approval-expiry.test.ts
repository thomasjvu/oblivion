import assert from "node:assert/strict";
import test from "node:test";
import { activateTestCase, post, startTestServer } from "../helpers/http.js";

test("approve rejects expired disclosure cards", async () => {
  const { server, base, store } = await startTestServer();
  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard"
    }, 201);
    activateTestCase(store, created.case.id);
    const proposed = await post(base, "/api/actions/propose", {
      caseId: created.case.id,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      purpose: "Remove profile",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: false
    }, 201);
    const approval = store.approvals.get(proposed.approval.id);
    assert.ok(approval);
    approval!.expiresAt = new Date(Date.now() - 60_000).toISOString();
    store.approvals.set(approval!.id, approval!);
    await post(
      base,
      `/api/approvals/${proposed.approval.id}/approve`,
      { userConfirmation: "I approve this exact action" },
      422
    );
  } finally {
    server.close();
  }
});