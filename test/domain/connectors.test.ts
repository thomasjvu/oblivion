import test from "node:test";
import assert from "node:assert/strict";
import { connectorById, connectorHasVerifiedSource } from "../../src/domain/connectors.js";
import { assertSensitiveExecutionAllowed } from "../../src/domain/runtimeGuard.js";
import { sourceVerificationFor } from "../../src/domain/sourceVerification.js";

test("connector registry marks HIBP password range as prefix-safe", () => {
  const connector = connectorById("hibp-password-range");

  assert.equal(connector?.requiresManagedPlaintext, false);
  assert.equal(connector?.requiredApproval?.actionType, "pwned-password-range-check");
  assert.match(connector?.redactionPolicy.join(" ") ?? "", /never accept or transmit full passwords/);
  assert.equal(connectorHasVerifiedSource("hibp-password-range"), true);
});

test("connector registry blocks HIBP email as managed plaintext unless TEE verified", () => {
  const connector = connectorById("hibp-email");

  assert.equal(connector?.requiresManagedPlaintext, true);
  assert.equal(connector?.requiredApproval?.exactDestinationRequired, true);
  assert.throws(() => assertSensitiveExecutionAllowed({
    proof: { verifierResult: "not-configured" },
    requiresManagedPlaintext: connector!.requiresManagedPlaintext,
    localSafe: false
  }), /runtime-not-tee-verified/);
  assert.doesNotThrow(() => assertSensitiveExecutionAllowed({
    proof: { verifierResult: "pass" },
    requiresManagedPlaintext: connector!.requiresManagedPlaintext,
    localSafe: false
  }));
});

test("source verification registry covers official cleanup routes", () => {
  assert.equal(sourceVerificationFor("google-removal-plan")?.officialUrl, "https://support.google.com/websearch/answer/12719076");
  assert.equal(sourceVerificationFor("california-drop-guided")?.officialUrl, "https://privacy.ca.gov/drop/");
  assert.match(sourceVerificationFor("gdpr-template")?.claimVerified ?? "", /not absolute/);
});

test("broker opt-out live connector requires managed plaintext", () => {
  const connector = connectorById("broker-opt-out-live");
  assert.equal(connector?.requiresManagedPlaintext, true);
  assert.equal(connector?.requiredApproval?.actionType, "broker-opt-out");
  assert.equal(connectorHasVerifiedSource("broker-registry-sweep"), true);
});

test("content takedown connectors register dmca and platform abuse paths", () => {
  assert.equal(connectorById("dmca-notice-drafter")?.requiredApproval?.actionType, "dmca-takedown");
  assert.equal(connectorById("platform-abuse-live")?.requiresManagedPlaintext, true);
  assert.equal(sourceVerificationFor("dmca-notice-drafter")?.officialUrl, "https://www.copyright.gov/dmca/");
});

