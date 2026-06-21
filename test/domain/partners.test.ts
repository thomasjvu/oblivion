import assert from "node:assert/strict";
import test from "node:test";
import { hashPartnerApiKey, partnerFromAuthorization, partnerPresetAllowlist } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";

test("partnerFromAuthorization resolves bearer key", () => {
  const apiKey = "obl_live_demo";
  const partner: PartnerRecord = {
    id: "demo",
    name: "demo",
    apiKeyHash: hashPartnerApiKey(apiKey),
    environment: "production",
    balanceCredits: 100,
    webhookEvents: ["case.created"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const map = new Map([[partner.id, partner]]);
  const resolved = partnerFromAuthorization(`Bearer ${apiKey}`, map);
  assert.equal(resolved?.id, "demo");
  assert.equal(partnerFromAuthorization("Bearer wrong", map), undefined);
});

test("parseSandboxPartnerKeysFromEnv sets sandbox environment", async () => {
  const { parseSandboxPartnerKeysFromEnv } = await import("../../src/domain/partners.js");
  const previous = process.env.OBLIVION_PARTNER_SANDBOX_KEYS;
  process.env.OBLIVION_PARTNER_SANDBOX_KEYS = "acme-sandbox:obl_sandbox_test";
  const partners = parseSandboxPartnerKeysFromEnv();
  assert.equal(partners[0]?.environment, "sandbox");
  assert.equal(partners[0]?.id, "acme-sandbox");
  if (previous) process.env.OBLIVION_PARTNER_SANDBOX_KEYS = previous;
  else delete process.env.OBLIVION_PARTNER_SANDBOX_KEYS;
});

test("partnerPresetAllowlist defaults to core partner-safe presets", () => {
  const previous = process.env.OBLIVION_PARTNER_PRESETS;
  delete process.env.OBLIVION_PARTNER_PRESETS;
  const allowlist = partnerPresetAllowlist();
  assert.ok(allowlist.has("people-search-cleanup"));
  assert.ok(allowlist.has("breach-exposure"));
  assert.ok(allowlist.has("search-result-suppression"));
  assert.ok(allowlist.has("california-drop"));
  assert.ok(allowlist.has("gdpr-erasure"));
  assert.ok(!allowlist.has("high-risk-safety"));
  if (previous) process.env.OBLIVION_PARTNER_PRESETS = previous;
});