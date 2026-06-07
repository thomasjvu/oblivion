import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeForLog, safeJson } from "../../src/domain/safeLogging.js";

test("safe logging redacts obvious identifiers and encrypted payload fields", () => {
  const sanitized = sanitizeForLog({
    email: "person@example.com",
    encryptedIntake: {
      ciphertext: "secret-ciphertext",
      nonce: "secret-nonce"
    },
    nested: {
      userConfirmation: "I approve person@example.com"
    }
  });

  const json = JSON.stringify(sanitized);
  assert.doesNotMatch(json, /person@example\.com/);
  assert.doesNotMatch(json, /secret-ciphertext/);
  assert.doesNotMatch(json, /secret-nonce/);
  assert.match(json, /\[redacted\]/);
});

test("safeJson does not leak phone numbers", () => {
  assert.doesNotMatch(safeJson({ message: "Call 212-555-1212" }), /212-555-1212/);
});
