import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";

const originalFetch = globalThis.fetch;

test("findings discover confirm and reject advance match review", async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("search.brave.com")) {
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return originalFetch(url, init);
  };
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const created = await post(base, "/api/cases", { jurisdiction: "US", authorityBasis: "self" }, 201);
    const caseId = created.case.id;
    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: encryptedBlob(caseId),
      redactedScope: {
        personLabel: "John Smith",
        aliases: ["J. Smith"],
        approvedIdentifierLabels: ["city-state"],
        sensitiveConstraints: []
      }
    });
    await post(base, `/api/cases/${caseId}/preset`, { presetId: "people-search-cleanup" }, 201);

    const discovered = await post(
      base,
      `/api/cases/${caseId}/findings/discover`,
      {
        pastedUrls: [
          "https://www.fastbackgroundcheck.com/people/john-smith/id/f-example123",
          "https://rocketreach.co/john-smith-email_example",
          "https://example.com/other-person"
        ]
      },
      201
    );
    assert.ok(discovered.discovered.length >= 2);

    const list = await get(base, `/api/cases/${caseId}/findings`);
    assert.ok(list.pendingFindings.length >= 2);
    for (const [index, finding] of list.pendingFindings.entries()) {
      const path = index === 0 ? "confirm" : "reject";
      await post(base, `/api/cases/${caseId}/findings/${finding.id}/${path}`, {}, 200);
    }

    const after = await get(base, `/api/cases/${caseId}/findings`);
    assert.equal(after.pendingFindings.length, 0);
    assert.ok(after.confirmedFindings.length >= 1);

    for (let i = 0; i < 6; i += 1) {
      await post(base, `/api/cases/${caseId}/agent/run`, {}, 200);
    }
    const plan = await get(base, `/api/cases/${caseId}/plan`);
    assert.notEqual(plan.plan?.currentStep, "confirm-matches");
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
  }
});

async function get(base: string, path: string) {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  if (!response.ok) throw json;
  return json;
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

function encryptedBlob(aad: string) {
  return {
    alg: "AES-256-GCM",
    keyId: "test-key",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "BBBBBBBBBBBBBBBB",
    aad
  };
}