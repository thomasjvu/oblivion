import assert from "node:assert/strict";
import test from "node:test";
import { emitApprovalPendingWebhook, notifyCasePendingApprovals } from "../../src/domain/webhooks.js";
import type { Approval, CaseRecord, PartnerRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedPartnerCase(store: MemoryStore): { caseRecord: CaseRecord; partner: PartnerRecord } {
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: "partner_wh",
    name: "Webhook Partner",
    apiKeyHash: "hash",
    environment: "production",
    balanceCredits: 100,
    webhookUrl: "https://127.0.0.1:9/inbox",
    webhookSecret: "b".repeat(64),
    webhookEvents: ["approval.pending"],
    createdAt: now,
    updatedAt: now
  };
  const caseRecord: CaseRecord = {
    id: "case_wh",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_wh",
    partnerId: partner.id,
    createdAt: now,
    updatedAt: now
  };
  const approval: Approval = {
    id: "approval_wh",
    caseId: caseRecord.id,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "removal",
    disclosureRisk: "medium",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "pending",
    createdAt: now
  };
  store.partners.set(partner.id, partner);
  store.cases.set(caseRecord.id, caseRecord);
  store.approvals.set(approval.id, approval);
  return { caseRecord, partner };
}

test("emitApprovalPendingWebhook emits once per approval", async () => {
  const store = new MemoryStore();
  const { caseRecord } = seedPartnerCase(store);
  const approval = store.approvals.get("approval_wh")!;

  await emitApprovalPendingWebhook(store, caseRecord.id, approval);
  await emitApprovalPendingWebhook(store, caseRecord.id, approval);

  const deliveries = [...store.webhookDeliveries.values()].filter(
    (delivery) => delivery.event === "approval.pending"
  );
  assert.equal(deliveries.length, 1);
  assert.ok(store.approvals.get(approval.id)?.pendingWebhookEmittedAt);
});

test("notifyCasePendingApprovals does not re-emit on repeated agent steps", async () => {
  const store = new MemoryStore();
  const { caseRecord } = seedPartnerCase(store);

  await notifyCasePendingApprovals(store, caseRecord.id);
  await notifyCasePendingApprovals(store, caseRecord.id);
  await notifyCasePendingApprovals(store, caseRecord.id);

  const deliveries = [...store.webhookDeliveries.values()].filter(
    (delivery) => delivery.event === "approval.pending"
  );
  assert.equal(deliveries.length, 1);
});