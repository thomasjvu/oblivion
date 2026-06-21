import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeOutboundHttpsUrl, isSafeOutboundHttpsUrl } from "../../src/domain/safeOutboundUrl.js";
import { DomainError } from "../../src/domain/errors.js";

test("assertSafeOutboundHttpsUrl allows public https hosts", () => {
  assert.doesNotThrow(() => assertSafeOutboundHttpsUrl("https://partner.example/callback"));
});

test("assertSafeOutboundHttpsUrl blocks loopback and metadata hosts", () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://10.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data"
  ]) {
    assert.throws(() => assertSafeOutboundHttpsUrl(url), DomainError);
    assert.equal(isSafeOutboundHttpsUrl(url), false);
  }
});