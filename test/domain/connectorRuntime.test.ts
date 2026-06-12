import test from "node:test";
import assert from "node:assert/strict";
import { connectorIdForAction } from "../../src/domain/connectorRuntime.js";

test("connectorIdForAction maps sensitive and guidance action types", () => {
  assert.equal(connectorIdForAction("hibp-email-check"), "hibp-email");
  assert.equal(connectorIdForAction("pwned-password-range-check"), "hibp-password-range");
  assert.equal(connectorIdForAction("search-result-removal"), "google-removal-plan");
  assert.equal(connectorIdForAction("gdpr-erasure"), "gdpr-template");
  assert.equal(connectorIdForAction("uk-gdpr-erasure"), "gdpr-template");
  assert.equal(connectorIdForAction("follow-up"), "california-drop-guided");
  assert.equal(connectorIdForAction("dmca-takedown"), "dmca-notice-drafter");
  assert.equal(connectorIdForAction("platform-abuse-report"), "platform-abuse-live");
});

test("connectorIdForAction uses guidance when broker is not tee-automatable", () => {
  assert.equal(connectorIdForAction("broker-opt-out", "unknown-broker"), "people-search-guidance");
});

test("connectorIdForAction selects live broker connector when tee-automatable", () => {
  assert.equal(connectorIdForAction("broker-opt-out", "spokeo"), "broker-opt-out-live");
});