import assert from "node:assert/strict";
import test from "node:test";
import { partnerFetch, startPartnerServer } from "../helpers/partner.js";

const TEST_KEY = "obl_billing_partner_key";
const TEST_PARTNER_ID = "billpartner";

test("partner invoice close lists usage by period", async () => {
  const { server, base } = await startPartnerServer({
    id: TEST_PARTNER_ID,
    key: TEST_KEY,
    name: "Billing Partner"
  });
  try {
    await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self" },
      expectedStatus: 201,
      apiKey: TEST_KEY
    });
    const period = new Date().toISOString().slice(0, 7);
    const closed = await partnerFetch(base, "/v1/billing/invoices/close", {
      method: "POST",
      body: { period },
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    assert.equal(closed.json.invoice.totalCredits, 10);
    const listed = await partnerFetch(base, "/v1/billing/invoices", { expectedStatus: 200, apiKey: TEST_KEY });
    assert.equal(listed.json.invoices.length, 1);
    const detail = await partnerFetch(base, `/v1/billing/invoices/${closed.json.invoice.id}`, {
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    assert.equal(detail.json.invoice.period, period);
  } finally {
    server.close();
  }
});