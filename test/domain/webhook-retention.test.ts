import assert from "node:assert/strict";
import test from "node:test";
import { pruneStaleWebhookDeliveries } from "../../src/domain/webhooks.js";
import type { PartnerWebhookDelivery } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("pruneStaleWebhookDeliveries removes old terminal deliveries", () => {
  const store = new MemoryStore();
  const stale: PartnerWebhookDelivery = {
    id: "wh_stale",
    partnerId: "partner_1",
    event: "case.created",
    status: "delivered",
    attemptCount: 1,
    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    deliveredAt: new Date().toISOString()
  };
  const fresh: PartnerWebhookDelivery = {
    id: "wh_fresh",
    partnerId: "partner_1",
    event: "case.created",
    status: "delivered",
    attemptCount: 1,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString()
  };
  const pendingRetry: PartnerWebhookDelivery = {
    id: "wh_retry",
    partnerId: "partner_1",
    event: "case.created",
    status: "failed",
    attemptCount: 1,
    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    nextRetryAt: new Date(Date.now() + 60_000).toISOString()
  };
  store.webhookDeliveries.set(stale.id, stale);
  store.webhookDeliveries.set(fresh.id, fresh);
  store.webhookDeliveries.set(pendingRetry.id, pendingRetry);

  const pruned = pruneStaleWebhookDeliveries(store);

  assert.equal(pruned, 1);
  assert.equal(store.webhookDeliveries.has("wh_stale"), false);
  assert.equal(store.webhookDeliveries.has("wh_fresh"), true);
  assert.equal(store.webhookDeliveries.has("wh_retry"), true);
});