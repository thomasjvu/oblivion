import test from "node:test";
import assert from "node:assert/strict";
import {
  activateTestCase,
  createCaseWithIntake,
  encryptedBlob,
  post,
  startTestServer
} from "../helpers/http.js";

const originalBypass = process.env.OBLIVION_CREDITS_BYPASS;
const originalHackathon = process.env.HACKATHON_MODE;

test("workflow routes require per-case payment before activation", async () => {
  delete process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.HACKATHON_MODE;
  const { server, base, store } = await startTestServer();

  try {
    const created = await post(
      base,
      "/api/cases",
      { jurisdiction: "US", authorityBasis: "self", riskLevel: "standard" },
      201
    );
    const caseId = created.case.id;
    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: encryptedBlob(caseId),
      redactedScope: {
        personLabel: "A.B.",
        aliases: [],
        approvedIdentifierLabels: ["email"],
        sensitiveConstraints: []
      }
    });

    const unpaidPreset = await fetch(`${base}/api/cases/${caseId}/preset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.accessToken}`
      },
      body: JSON.stringify({ presetId: "people-search-cleanup" })
    });
    assert.equal(unpaidPreset.status, 402);
    const unpaidJson = await unpaidPreset.json();
    assert.equal(unpaidJson.error, "case-activation-required");

    activateTestCase(store, caseId);
    await post(
      base,
      `/api/cases/${caseId}/preset`,
      { presetId: "people-search-cleanup" },
      201
    );
  } finally {
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
    if (originalHackathon === undefined) delete process.env.HACKATHON_MODE;
    else process.env.HACKATHON_MODE = originalHackathon;
    server.close();
  }
});

test("createCaseWithIntake helper activates cases for downstream workflow tests", async () => {
  delete process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.HACKATHON_MODE;
  const { server, base, store } = await startTestServer();

  try {
    const created = await createCaseWithIntake(base, "US", "standard", store);
    await post(
      base,
      `/api/cases/${created.caseId}/preset`,
      { presetId: "people-search-cleanup" },
      201
    );
  } finally {
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
    if (originalHackathon === undefined) delete process.env.HACKATHON_MODE;
    else process.env.HACKATHON_MODE = originalHackathon;
    server.close();
  }
});