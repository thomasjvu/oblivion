import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../../src/api/app.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";
import { encryptedBlob } from "../helpers/http.js";

const TEST_KEY = "obl_test_partner_secret";
const TEST_PARTNER_ID = "testpartner";

function seedTestPartner(store: ReturnType<typeof createApp>["store"]) {
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: TEST_PARTNER_ID,
    name: "Test Partner",
    apiKeyHash: hashPartnerApiKey(TEST_KEY),
    environment: "production",
    balanceCredits: 500,
    webhookEvents: ["case.created", "approval.pending", "action.executed", "recheck.due", "case.completed", "case.deleted"],
    createdAt: now,
    updatedAt: now
  };
  store.partners.set(partner.id, partner);
}

async function partnerFetch(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; expectedStatus?: number } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if (options.expectedStatus) assert.equal(response.status, options.expectedStatus, JSON.stringify(json));
  return { response, json };
}

test("partner v1 API creates scoped case and rejects unauthenticated export", async () => {
  const previous = process.env.OBLIVION_PARTNER_KEYS;
  delete process.env.OBLIVION_PARTNER_KEYS;
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const unauthorized = await fetch(`${base}/v1/cases`, { method: "GET" });
    assert.equal(unauthorized.status, 401);

    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "user_99" },
      expectedStatus: 201
    });
    assert.equal(created.json.case.partnerId, TEST_PARTNER_ID);
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
    const consumerJson = await consumerList.json();
    assert.equal(consumerJson.cases.length, 0);
  } finally {
    server.close();
    if (previous) process.env.OBLIVION_PARTNER_KEYS = previous;
  }
});

test("partner idempotent create and webhook inbox", async () => {
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
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
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
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
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  try {
    const rotated = await partnerFetch(base, "/v1/partners/me/rotate-key", {
      method: "POST",
      body: {},
      expectedStatus: 200
    });
    assert.match(rotated.json.apiKey, /^obl_live_/);
    const oldKeyStillWorks = await fetch(`${base}/v1/partners/me`, {
      headers: { authorization: `Bearer ${TEST_KEY}` }
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
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  try {
    const presets = await partnerFetch(base, "/v1/presets", { expectedStatus: 200 });
    const ids = presets.json.presets.map((preset: { id: string }) => preset.id);
    assert.ok(ids.includes("people-search-cleanup"));
    assert.ok(ids.includes("breach-exposure"));
    assert.equal(ids.includes("gdpr-erasure"), false);
  } finally {
    server.close();
  }
});

test("partner preset allowlist blocks unsupported presets", async () => {
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "EU", authorityBasis: "self" },
      expectedStatus: 201
    });
    const caseId = created.json.case.id as string;
    const blocked = await partnerFetch(base, `/v1/cases/${caseId}/preset`, {
      method: "POST",
      body: { presetId: "gdpr-erasure" },
      expectedStatus: 422
    });
    assert.equal(blocked.json.error, "preset-not-available-for-partners");
  } finally {
    server.close();
  }
});