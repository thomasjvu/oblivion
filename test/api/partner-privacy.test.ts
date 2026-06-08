import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../../src/api/app.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";
import { encryptedBlob } from "../helpers/http.js";

const TEST_KEY = "obl_privacy_partner_key";
const TEST_PARTNER_ID = "privpartner";

function seedTestPartner(store: ReturnType<typeof createApp>["store"]) {
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: TEST_PARTNER_ID,
    name: "Privacy Partner",
    apiKeyHash: hashPartnerApiKey(TEST_KEY),
    environment: "production",
    balanceCredits: 500,
    webhookEvents: ["case.deleted"],
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

test("partner export and delete create audit trail without leaking confirmation text", async () => {
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "privacy_1" },
      expectedStatus: 201
    });
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

    const exported = await partnerFetch(base, `/v1/cases/${caseId}/export`, { expectedStatus: 200 });
    const serialized = JSON.stringify(exported.json);
    assert.doesNotMatch(serialized, /userConfirmation/);
    assert.equal(exported.json.case.encryptedIntake.ciphertext, encryptedBlob(caseId).ciphertext);

    const audit = await partnerFetch(base, "/v1/partners/me/data-access", { expectedStatus: 200 });
    assert.equal(audit.json.events.length, 1);
    assert.equal(audit.json.events[0].action, "export");

    await partnerFetch(base, `/v1/cases/${caseId}`, { method: "DELETE", expectedStatus: 200 });
    const auditAfterDelete = await partnerFetch(base, "/v1/partners/me/data-access", { expectedStatus: 200 });
    assert.equal(auditAfterDelete.json.events[0].action, "delete");
  } finally {
    server.close();
  }
});

test("partner authenticated consumer export is allowed and audited", async () => {
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
    const exported = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ caseId })
    });
    assert.equal(exported.status, 200);
    const audit = await partnerFetch(base, "/v1/partners/me/data-access?caseId=" + caseId, { expectedStatus: 200 });
    assert.equal(audit.json.events[0].action, "export");
    assert.equal(audit.json.events[0].source, "api");
  } finally {
    server.close();
  }
});