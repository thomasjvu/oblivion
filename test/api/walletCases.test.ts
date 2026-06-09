import test from "node:test";
import assert from "node:assert/strict";
import {
  activateTestCase,
  clearCaseToken,
  createCaseWithIntake,
  get,
  post,
  startTestServer
} from "../helpers/http.js";
import { settleCreditsForProduct } from "../../src/domain/credits.js";

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

test("wallet case index lists linked cases without leaking tokens", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await createCaseWithIntake(base, "US", "standard", store);
    activateTestCase(store, created.caseId);
    await post(
      base,
      "/api/wallet/cases/link",
      { caseId: created.caseId, walletAddress: WALLET },
      200
    );

    const listed = await get(
      base,
      `/api/wallet/cases?walletAddress=${encodeURIComponent(WALLET)}`,
      200
    );
    assert.equal(listed.cases.length, 1);
    assert.equal(listed.cases[0].id, created.caseId);
    assert.equal(listed.cases[0].accessToken, undefined);
    assert.ok(listed.cases[0].personLabel);
  } finally {
    server.close();
  }
});

test("wallet case link requires case bearer token", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await post(
      base,
      "/api/cases",
      { jurisdiction: "US", authorityBasis: "self", riskLevel: "standard" },
      201
    );
    const caseId = created.case.id;
    clearCaseToken(caseId);

    const response = await fetch(`${base}/api/wallet/cases/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId, walletAddress: WALLET })
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("subscription wallet auto-activates new cases", async () => {
  delete process.env.OBLIVION_CREDITS_BYPASS;
  delete process.env.HACKATHON_MODE;
  const { server, base, store } = await startTestServer();

  try {
    settleCreditsForProduct(store, WALLET, "subscription");
    const created = await post(
      base,
      "/api/cases",
      { jurisdiction: "US", authorityBasis: "self", riskLevel: "standard" },
      201
    );
    const caseId = created.case.id;
    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake: {
        alg: "AES-256-GCM",
        keyId: "test-key",
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "BBBBBBBBBBBBBBBB",
        aad: caseId
      },
      redactedScope: {
        personLabel: "A.B.",
        aliases: [],
        approvedIdentifierLabels: [],
        sensitiveConstraints: []
      }
    });

    const preset = await fetch(`${base}/api/cases/${caseId}/preset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.accessToken}`
      },
      body: JSON.stringify({
        presetId: "people-search-cleanup",
        walletAddress: WALLET
      })
    });
    assert.equal(preset.status, 201, await preset.text());
  } finally {
    server.close();
  }
});