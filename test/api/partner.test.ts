import assert from "node:assert/strict";
import test from "node:test";
import { encryptedBlob } from "../helpers/http.js";
import { DEFAULT_TEST_KEY, DEFAULT_TEST_PARTNER_ID, partnerFetch, startPartnerServer } from "../helpers/partner.js";

test("partner v1 API creates scoped case and rejects unauthenticated export", async () => {
  const previous = process.env.OBLIVION_PARTNER_KEYS;
  delete process.env.OBLIVION_PARTNER_KEYS;
  const { server, base } = await startPartnerServer();

  try {
    const unauthorized = await fetch(`${base}/v1/cases`, { method: "GET" });
    assert.equal(unauthorized.status, 401);

    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "user_99" },
      expectedStatus: 201
    });
    assert.equal(created.json.case.partnerId, DEFAULT_TEST_PARTNER_ID);
    assert.equal(created.json.case.externalRef, "user_99");

    const caseId = created.json.case.id as string;
    await partnerFetch(base, `/v1/cases/${caseId}/intake`, {
      method: "POST",
      body: {
        encryptedIntake: encryptedBlob(caseId),
        redactedScope: {
          personLabel: "A.B.",
          aliases: [],
          approvedIdentifierLabels: ["email"],
          sensitiveConstraints: []
        }
      },
      expectedStatus: 200
    });

    await partnerFetch(base, `/v1/cases/${caseId}/preset`, {
      method: "POST",
      body: { presetId: "people-search-cleanup" },
      expectedStatus: 201
    });

    const status = await partnerFetch(base, `/v1/cases/${caseId}/status`, { expectedStatus: 200 });
    assert.equal(status.json.caseId, caseId);

    const exportBlocked = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId })
    });
    assert.equal(exportBlocked.status, 401);

    const list = await partnerFetch(base, "/v1/cases", { expectedStatus: 200 });
    assert.equal(list.json.cases.length, 1);

    const consumerList = await fetch(`${base}/api/cases`);
    assert.equal(consumerList.status, 401);
    assert.equal((await consumerList.json()).error, "case-list-not-available");
  } finally {
    server.close();
    if (previous) process.env.OBLIVION_PARTNER_KEYS = previous;
  }
});

test("partner idempotent create and webhook inbox", async () => {
  const { server, base } = await startPartnerServer();
  try {
    const first = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "idem_1" },
      expectedStatus: 201
    });
    const second = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "idem_1" },
      expectedStatus: 200
    });
    assert.equal(second.json.idempotent, true);
    assert.equal(second.json.case.id, first.json.case.id);

    await partnerFetch(base, "/v1/webhooks/register-inbox", { method: "POST", body: {}, expectedStatus: 200 });
    await partnerFetch(base, "/v1/webhooks/test", {
      method: "POST",
      body: { event: "case.created", caseId: first.json.case.id },
      expectedStatus: 200
    });
    const inbox = await partnerFetch(base, "/v1/partners/me/webhook-inbox", { expectedStatus: 200 });
    assert.ok(inbox.json.entries.length >= 1);
    assert.equal(inbox.json.entries[0].signatureValid, true);
  } finally {
    server.close();
  }
});

test("partner delete case removes partner-scoped record", async () => {
  const { server, base } = await startPartnerServer();
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self" },
      expectedStatus: 201
    });
    const caseId = created.json.case.id as string;
    await partnerFetch(base, `/v1/cases/${caseId}`, { method: "DELETE", expectedStatus: 200 });
    const list = await partnerFetch(base, "/v1/cases", { expectedStatus: 200 });
    assert.equal(list.json.cases.length, 0);
  } finally {
    server.close();
  }
});

test("partner rotate-key returns new api key", async () => {
  const { server, base } = await startPartnerServer();
  try {
    const rotated = await partnerFetch(base, "/v1/partners/me/rotate-key", {
      method: "POST",
      body: {},
      expectedStatus: 200
    });
    assert.match(rotated.json.apiKey, /^obl_live_/);
    const oldKeyStillWorks = await fetch(`${base}/v1/partners/me`, {
      headers: { authorization: `Bearer ${DEFAULT_TEST_KEY}` }
    });
    assert.equal(oldKeyStillWorks.status, 401);
    const newKeyWorks = await fetch(`${base}/v1/partners/me`, {
      headers: { authorization: `Bearer ${rotated.json.apiKey}` }
    });
    assert.equal(newKeyWorks.status, 200);
  } finally {
    server.close();
  }
});

test("partner presets endpoint returns allowlisted catalog", async () => {
  const { server, base } = await startPartnerServer();
  try {
    const presets = await partnerFetch(base, "/v1/presets", { expectedStatus: 200 });
    const ids = presets.json.presets.map((preset: { id: string }) => preset.id);
    assert.ok(ids.includes("people-search-cleanup"));
    assert.ok(ids.includes("breach-exposure"));
    assert.ok(ids.includes("gdpr-erasure"));
    assert.equal(ids.includes("high-risk-safety"), false);
  } finally {
    server.close();
  }
});

test("partner preset allowlist blocks unsupported presets", async () => {
  const { server, base } = await startPartnerServer();
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "EU", authorityBasis: "self" },
      expectedStatus: 201
    });
    const caseId = created.json.case.id as string;
    const blocked = await partnerFetch(base, `/v1/cases/${caseId}/preset`, {
      method: "POST",
      body: { presetId: "high-risk-safety" },
      expectedStatus: 422
    });
    assert.equal(blocked.json.error, "preset-not-available-for-partners");
  } finally {
    server.close();
  }
});