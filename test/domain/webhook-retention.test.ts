import assert from "node:assert/strict";
import test from "node:test";
import { pruneStaleWebhookDeliveries, pruneStaleWebhookInboxEntries } from "../../src/domain/webhooks.js";
import type { PartnerWebhookInboxEntry } from "../../src/domain/types.js";
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

test("pruneStaleWebhookInboxEntries removes stale inbox rows and enforces per-partner cap", () => {
  const store = new MemoryStore();
  const stale: PartnerWebhookInboxEntry = {
    id: "inbox_stale",
    partnerId: "partner_1",
    event: "case.created",
    payload: { caseId: "case_1" },
    signatureValid: true,
    receivedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  };
  const fresh: PartnerWebhookInboxEntry = {
    id: "inbox_fresh",
    partnerId: "partner_1",
    event: "case.created",
    payload: { caseId: "case_2" },
    signatureValid: true,
    receivedAt: new Date().toISOString()
  };
  store.partnerWebhookInbox.set(stale.id, stale);
  store.partnerWebhookInbox.set(fresh.id, fresh);
  process.env.OBLIVION_WEBHOOK_INBOX_MAX_ENTRIES_PER_PARTNER = "1";
  const pruned = pruneStaleWebhookInboxEntries(store);
  assert.ok(pruned >= 1);
  assert.equal(store.partnerWebhookInbox.has("inbox_fresh"), true);
  delete process.env.OBLIVION_WEBHOOK_INBOX_MAX_ENTRIES_PER_PARTNER;
});