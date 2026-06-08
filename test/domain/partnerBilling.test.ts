import assert from "node:assert/strict";
import test from "node:test";
import {
  creditPartnerPool,
  meterPartnerAiTokens,
  meterPartnerUsage,
  partnerAiCreditsForTokens
} from "../../src/domain/partnerBilling.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

function seedPartner(balanceCredits = 20): PartnerRecord {
  const now = new Date().toISOString();
  return {
    id: "billing-test",
    name: "Billing Test",
    apiKeyHash: hashPartnerApiKey("key"),
    environment: "production",
    balanceCredits,
    webhookEvents: ["case.created"],
    createdAt: now,
    updatedAt: now
  };
}

test("meterPartnerUsage debits credits and records usage", () => {
  const store = new MemoryStore();
  const partner = seedPartner(20);
  store.partners.set(partner.id, partner);
  const updated = meterPartnerUsage(store, partner, "case");
  assert.equal(updated.balanceCredits, 10);
  assert.equal(store.partnerUsage.size, 1);
});

test("meterPartnerUsage rejects insufficient credits", () => {
  const store = new MemoryStore();
  const partner = seedPartner(5);
  store.partners.set(partner.id, partner);
  assert.throws(() => meterPartnerUsage(store, partner, "case"), (error: Error & { statusCode?: number }) => {
    assert.equal(error.message, "partner-credits-insufficient");
    assert.equal(error.statusCode, 402);
    return true;
  });
});

test("partnerAiCreditsForTokens scales with token usage", () => {
  assert.equal(partnerAiCreditsForTokens(0), 2);
  assert.equal(partnerAiCreditsForTokens(50), 2);
  assert.equal(partnerAiCreditsForTokens(250), 6);
});

test("meterPartnerAiTokens debits partner pool for partner cases", () => {
  const store = new MemoryStore();
  const partner = seedPartner(100);
  store.partners.set(partner.id, partner);
  const caseId = "case_ai_meter";
  store.cases.set(caseId, {
    id: caseId,
    jurisdiction: "US",
    riskLevel: "standard",
    authorityBasis: "self",
    partnerId: partner.id,
    retentionDays: 30,
    encryptedVaultPointer: "vault",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const updated = meterPartnerAiTokens(store, caseId, 180);
  assert.equal(updated?.balanceCredits, 96);
  const aiUsage = [...store.partnerUsage.values()].find((entry) => entry.kind === "ai");
  assert.equal(aiUsage?.credits, 4);
});

test("creditPartnerPool tops up partner balance", () => {
  const store = new MemoryStore();
  const partner = seedPartner(10);
  store.partners.set(partner.id, partner);
  const updated = creditPartnerPool(store, partner, 50);
  assert.equal(updated.balanceCredits, 60);
});