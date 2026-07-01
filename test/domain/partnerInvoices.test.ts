import assert from "node:assert/strict";
import test from "node:test";
import { closePartnerInvoicePeriod, listPartnerInvoices } from "../../src/domain/partnerInvoices.js";
import { meterPartnerUsage } from "../../src/domain/partnerBilling.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedPartner(store: MemoryStore): PartnerRecord {
  const now = "2026-06-01T00:00:00.000Z";
  const partner: PartnerRecord = {
    id: "acme",
    name: "Acme",
    apiKeyHash: hashPartnerApiKey("key"),
    environment: "production",
    balanceCredits: 1000,
    webhookEvents: ["case.created"],
    createdAt: now,
    updatedAt: now
  };
  store.partners.set(partner.id, partner);
  return partner;
}

test("closePartnerInvoicePeriod aggregates usage and is idempotent", () => {
  const store = new MemoryStore();
  const partner = seedPartner(store);
  meterPartnerUsage(store, partner, "case");
  meterPartnerUsage(store, partner, "discover", "case_1");
  const period = new Date().toISOString().slice(0, 7);
  const first = closePartnerInvoicePeriod(store, partner, period);
  assert.equal(first.totalCredits, 15);
  assert.equal(first.lineItems.length, 2);
  const second = closePartnerInvoicePeriod(store, partner, period);
  assert.equal(second.id, first.id);
  assert.equal(listPartnerInvoices(store, partner.id).length, 1);
});