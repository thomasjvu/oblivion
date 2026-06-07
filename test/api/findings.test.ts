import test from "node:test";
import assert from "node:assert/strict";
import { encryptedBlob, get, post, startTestServer } from "../helpers/http.js";

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
  const { server, base } = await startTestServer();

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