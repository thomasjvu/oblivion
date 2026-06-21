import assert from "node:assert/strict";
import test from "node:test";
import { post, startTestServer } from "../helpers/http.js";

test("1shot rpc requires case access token", async () => {
  const { server, base } = await startTestServer();
  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard"
    }, 201);
    const response = await fetch(`${base}/api/1shot/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caseId: created.case.id,
        method: "relayer_getStatus",
        params: {}
      })
    });
    const json = await response.json();
    assert.equal(response.status, 401, JSON.stringify(json));
  } finally {
    server.close();
  }
});

test("1shot webhook rejects missing callback token", async () => {
  const { server, base } = await startTestServer();
  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard"
    }, 201);
    const response = await fetch(`${base}/api/1shot/webhook?caseId=${created.case.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventName: "submitted" })
    });
    const json = await response.json();
    assert.equal(response.status, 401, JSON.stringify(json));
  } finally {
    server.close();
  }
});