import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../../src/api/app.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";

const TEST_KEY = "obl_billing_partner_key";
const TEST_PARTNER_ID = "billpartner";

function seedTestPartner(store: ReturnType<typeof createApp>["store"]) {
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: TEST_PARTNER_ID,
    name: "Billing Partner",
    apiKeyHash: hashPartnerApiKey(TEST_KEY),
    environment: "production",
    balanceCredits: 500,
    webhookEvents: ["case.created"],
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

test("partner invoice close lists usage by period", async () => {
  const { server, store } = createApp();
  seedTestPartner(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  try {
    await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self" },
      expectedStatus: 201
    });
    const period = new Date().toISOString().slice(0, 7);
    const closed = await partnerFetch(base, "/v1/billing/invoices/close", {
      method: "POST",
      body: { period },
      expectedStatus: 200
    });
    assert.equal(closed.json.invoice.totalCredits, 10);
    const listed = await partnerFetch(base, "/v1/billing/invoices", { expectedStatus: 200 });
    assert.equal(listed.json.invoices.length, 1);
    const detail = await partnerFetch(base, `/v1/billing/invoices/${closed.json.invoice.id}`, {
      expectedStatus: 200
    });
    assert.equal(detail.json.invoice.period, period);
  } finally {
    server.close();
  }
});