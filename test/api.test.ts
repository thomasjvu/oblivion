import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { encryptVaultPayload, createVaultKey } from "../src/crypto/clientVault.js";

test("case lifecycle enforces approval before execution", async () => {
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
    const key = await createVaultKey();
    const encryptedIntake = await encryptVaultPayload(key, { email: "person@example.com" }, caseId);

    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake,
      redactedScope: {
        personLabel: "User",
        aliases: [],
        approvedIdentifierLabels: ["p***@example.com"],
        sensitiveConstraints: []
      }
    });

    const readBack = await get(base, `/api/cases/${caseId}`);
    assert.equal(readBack.case.id, caseId);
    assert.equal(readBack.status.scope.personLabel, "User");

    const caseList = await get(base, "/api/cases");
    assert.equal(caseList.cases.length, 1);
    assert.equal(caseList.cases[0].id, caseId);

    const proposed = await post(base, "/api/actions/propose", {
      caseId,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      purpose: "Remove profile",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: true
    }, 201);

    const blocked = await post(base, `/api/actions/${proposed.action.id}/execute`, {}, 403);
    assert.equal(blocked.error, "execution-blocked");

    await post(base, `/api/approvals/${proposed.approval.id}/approve`, {
      userConfirmation: "I approve this exact action"
    });

    const executed = await post(base, `/api/actions/${proposed.action.id}/execute`, {});
    assert.equal(executed.action.executionStatus, "recorded");

    const exported = await post(base, "/api/export", { caseId });
    assert.equal(exported.case.encryptedIntake.ciphertext, encryptedIntake.ciphertext);
    assert.doesNotMatch(JSON.stringify(exported), /person@example\.com/);

    const deleted = await post(base, "/api/delete", { caseId });
    assert.equal(deleted.tombstone, true);
    await post(base, "/api/export", { caseId }, 404);
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
