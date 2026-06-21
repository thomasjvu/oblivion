import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPartnerWebhook } from "../../src/domain/webhooks.js";
import type { PartnerRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("dispatchPartnerWebhook skips delivery when webhook secret is missing", async () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: "partner_no_secret",
    name: "No Secret Partner",
    apiKeyHash: "hash",
    environment: "production",
    balanceCredits: 100,
    webhookUrl: "https://example.com/hook",
    webhookEvents: ["case.created"],
    createdAt: now,
    updatedAt: now
  };
  store.partners.set(partner.id, partner);
  const delivery = await dispatchPartnerWebhook(store, partner, "case.created", {
    caseId: "case_1"
  });
  assert.ok(delivery);
  assert.equal(delivery?.status, "failed");
  assert.equal(delivery?.error, "webhook-secret-missing");
});