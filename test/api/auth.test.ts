import test from "node:test";
import assert from "node:assert/strict";
import { clearCaseToken, encryptedBlob, get, post, startTestServer } from "../helpers/http.js";
import { partnerFetch, seedTestPartner } from "../helpers/partner.js";
import { createApp } from "../../src/api/app.js";
import { once } from "node:events";

test("missing case access token returns 401", async () => {
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", { jurisdiction: "US", authorityBasis: "self" }, 201);
    const caseId = created.case.id as string;
    clearCaseToken(caseId);

    const response = await fetch(`${base}/api/cases/${caseId}`);
    const json = await response.json();
    assert.equal(response.status, 401);
    assert.equal(json.error, "case-access-token-required");
  } finally {
    server.close();
  }
});

test("wrong case access token returns 401", async () => {
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", { jurisdiction: "US", authorityBasis: "self" }, 201);
    const caseId = created.case.id as string;

    const response = await fetch(`${base}/api/cases/${caseId}`, {
      headers: { authorization: "Bearer obl_wrong_token_value" }
    });
    const json = await response.json();
    assert.equal(response.status, 401);
    assert.equal(json.error, "case-access-token-required");
  } finally {
    server.close();
  }
});

test("partner case on consumer /api returns 403", async () => {
  const { server, store } = createApp();
  seedTestPartner(store, { id: "authpartner", key: "obl_auth_partner_key" });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self" },
      expectedStatus: 201,
      apiKey: "obl_auth_partner_key"
    });
    const caseId = created.json.case.id as string;

    const response = await fetch(`${base}/api/cases/${caseId}`, {
      headers: { authorization: "Bearer any-consumer-token" }
    });
    const json = await response.json();
    assert.equal(response.status, 403);
    assert.equal(json.error, "partner-case-use-v1-api");
  } finally {
    server.close();
  }
});

test("valid case access token works", async () => {
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", { jurisdiction: "US", authorityBasis: "self" }, 201);
    const caseId = created.case.id as string;
    assert.ok(created.accessToken);

    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: encryptedBlob(caseId),
      redactedScope: {
        personLabel: "A.B.",
        aliases: [],
        approvedIdentifierLabels: ["email"],
        sensitiveConstraints: []
      }
    });

    const readBack = await get(base, `/api/cases/${caseId}`);
    assert.equal(readBack.case.id, caseId);
    assert.equal(readBack.status.scope.personLabel, "A.B.");
    assert.equal(readBack.case.accessTokenHash, undefined);
  } finally {
    server.close();
  }
});