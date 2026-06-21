import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCaseCallbackWebhook } from "../../src/domain/webhooks.js";
import type { CaseRecord, PartnerRecord } from "../../src/domain/types.js";

test("dispatchCaseCallbackWebhook posts signed payload to case callback URL", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let signature = "";

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    signature = String(init?.headers && (init.headers as Record<string, string>)["x-oblivion-signature"]);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const now = new Date().toISOString();
    const partner: PartnerRecord = {
      id: "partner_cb",
      name: "Callback Partner",
      apiKeyHash: "hash",
      environment: "production",
      balanceCredits: 100,
      webhookSecret: "a".repeat(64),
      webhookEvents: ["case.created"],
      createdAt: now,
      updatedAt: now
    };
    const caseRecord: CaseRecord = {
      id: "case_cb",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      retentionDays: 30,
      encryptedVaultPointer: "vault_cb",
      partnerId: partner.id,
      callbackUrl: "https://partner.example/callback",
      createdAt: now,
      updatedAt: now
    };

    const result = await dispatchCaseCallbackWebhook(caseRecord, partner, "case.created", {
      caseId: caseRecord.id,
      externalRef: "ref-1"
    });

    assert.equal(requestedUrl, "https://partner.example/callback");
    assert.ok(signature);
    assert.equal(result?.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchCaseCallbackWebhook blocks unsafe callback hosts", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const now = new Date().toISOString();
    const partner: PartnerRecord = {
      id: "partner_blocked",
      name: "Blocked Partner",
      apiKeyHash: "hash",
      environment: "production",
      balanceCredits: 100,
      webhookSecret: "c".repeat(64),
      webhookEvents: ["case.created"],
      createdAt: now,
      updatedAt: now
    };
    const caseRecord: CaseRecord = {
      id: "case_blocked",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      retentionDays: 30,
      encryptedVaultPointer: "vault_blocked",
      partnerId: partner.id,
      callbackUrl: "https://127.0.0.1/callback",
      createdAt: now,
      updatedAt: now
    };

    const result = await dispatchCaseCallbackWebhook(caseRecord, partner, "case.created", {
      caseId: caseRecord.id
    });
    assert.equal(called, false);
    assert.equal(result?.ok, false);
    assert.equal(result?.error, "outbound-url-blocked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchCaseCallbackWebhook skips when callback matches partner webhook URL", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const now = new Date().toISOString();
    const partner: PartnerRecord = {
      id: "partner_dup",
      name: "Dup Partner",
      apiKeyHash: "hash",
      environment: "production",
      balanceCredits: 100,
      webhookUrl: "https://partner.example/hook",
      webhookSecret: "b".repeat(64),
      webhookEvents: ["case.created"],
      createdAt: now,
      updatedAt: now
    };
    const caseRecord: CaseRecord = {
      id: "case_dup",
      jurisdiction: "US",
      authorityBasis: "self",
      riskLevel: "standard",
      retentionDays: 30,
      encryptedVaultPointer: "vault_dup",
      partnerId: partner.id,
      callbackUrl: "https://partner.example/hook",
      createdAt: now,
      updatedAt: now
    };

    const result = await dispatchCaseCallbackWebhook(caseRecord, partner, "case.created", {
      caseId: caseRecord.id
    });
    assert.equal(result, undefined);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});