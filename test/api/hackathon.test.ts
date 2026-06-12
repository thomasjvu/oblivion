import test from "node:test";
import assert from "node:assert/strict";
import { activateTestCase, encryptedBlob, get, post, startTestServer } from "../helpers/http.js";

const originalHackathonMode = process.env.HACKATHON_MODE;

test("hackathon status route is unavailable when HACKATHON_MODE is off", async () => {
  delete process.env.HACKATHON_MODE;
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const response = await fetch(
      `${base}/api/hackathon/status?caseId=${created.case.id}`,
      { headers: { authorization: `Bearer ${created.accessToken}` } }
    );
    assert.equal(response.status, 404);
  } finally {
    server.close();
    if (originalHackathonMode === undefined) delete process.env.HACKATHON_MODE;
    else process.env.HACKATHON_MODE = originalHackathonMode;
  }
});

test("complete-pending shortcut route is removed", async () => {
  process.env.HACKATHON_MODE = "true";
  const { server, base } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const response = await fetch(`${base}/api/hackathon/complete-pending`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.accessToken}` },
      body: JSON.stringify({ caseId: created.case.id })
    });
    assert.equal(response.status, 404);
  } finally {
    server.close();
    if (originalHackathonMode === undefined) delete process.env.HACKATHON_MODE;
    else process.env.HACKATHON_MODE = originalHackathonMode;
  }
});

test("agent run-next endpoint requires a cleanup preset and advances the cleanup plan", async () => {
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