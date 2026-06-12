import test from "node:test";
import assert from "node:assert/strict";
import { buildTrustPrivacyResponse } from "../../src/domain/trustPrivacy.js";

test("buildTrustPrivacyResponse includes partner fields for partner audience", () => {
  const partner = buildTrustPrivacyResponse("partner");
  assert.equal(partner.partnerCanDecryptCaseVault, false);
  assert.match(String(partner.partnerIntegrationModel), /redacted metadata/i);
});

test("buildTrustPrivacyResponse omits partner fields for consumer audience", () => {
  const consumer = buildTrustPrivacyResponse("consumer");
  assert.equal("partnerCanDecryptCaseVault" in consumer, false);
  assert.match(String(consumer.message), /browser or an attested TEE/i);
});