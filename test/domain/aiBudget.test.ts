import test from "node:test";
import assert from "node:assert/strict";
import { assertAiBudget, AI_BUDGET_BY_MODE, resolveAiEntitlement } from "../../src/domain/aiBudget.js";
import { createPaymentSession } from "../../src/domain/hackathon.js";
import { markSessionPaid } from "../../src/domain/x402.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { CaseRecord } from "../../src/domain/types.js";

function seedCase(store: MemoryStore, caseId = "case_budget") {
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: caseId,
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    encryptedVaultPointer: "vault_demo",
    retentionDays: 90,
    redactedScope: {
      personLabel: "Demo",
      aliases: [],
      approvedIdentifierLabels: [],
      sensitiveConstraints: []
    },
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseId, caseRecord);
  return caseRecord;
}

test("payment catalog prices align with one-off and monthly subscription rails", () => {
  const oneOff = AI_BUDGET_BY_MODE["one-off"];
  const subscription = AI_BUDGET_BY_MODE.subscription;
  assert.equal(oneOff.maxChats, 5);
  assert.equal(subscription.maxChats, 30);
  assert.ok(oneOff.maxTokens < subscription.maxTokens);
});

test("assertAiBudget requires an entitled payment session", () => {
  const store = new MemoryStore();
  seedCase(store);
  assert.throws(
    () => assertAiBudget(store, "case_budget", "chat"),
    (error: Error & { code?: string }) => error.code === "ai-payment-required"
  );
});

test("paid payment session unlocks capped AI usage", () => {
  const priorPayTo = process.env.X402_PAY_TO;
  try {
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    const store = new MemoryStore();
    seedCase(store);
    const session = createPaymentSession({ caseId: "case_budget", mode: "one-off" });
    store.paymentSessions.set(session.id, markSessionPaid(session));
    const entitlement = assertAiBudget(store, "case_budget", "chat");
    assert.equal(entitlement.mode, "one-off");
    assert.equal(entitlement.limits?.maxChats, 5);
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
  }
});

test("resolveAiEntitlement prefers subscription over one-off", () => {
  const priorPayTo = process.env.X402_PAY_TO;
  try {
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
  const store = new MemoryStore();
  seedCase(store);
  const oneOff = createPaymentSession({ caseId: "case_budget", mode: "one-off" });
  const subscription = createPaymentSession({ caseId: "case_budget", mode: "subscription" });
  store.paymentSessions.set(oneOff.id, markSessionPaid(oneOff));
  store.paymentSessions.set(subscription.id, markSessionPaid(subscription));
    const view = resolveAiEntitlement(store, "case_budget");
    assert.equal(view.mode, "subscription");
    assert.equal(view.limits?.maxChats, AI_BUDGET_BY_MODE.subscription.maxChats);
  } finally {
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
  }
});