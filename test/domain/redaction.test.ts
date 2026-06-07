import test from "node:test";
import assert from "node:assert/strict";
import { detectForbiddenSecrets, redactEmail, redactIdentifier, redactText } from "../../src/domain/redaction.js";
import type { IdentifierCategory } from "../../src/domain/types.js";

const CATEGORIES: IdentifierCategory[] = [
  "legal-name",
  "alias",
  "email",
  "phone",
  "address",
  "city-state",
  "date-of-birth",
  "relative",
  "workplace",
  "school",
  "government-id",
  "ssn",
  "password",
  "payment",
  "infringing-url",
  "original-work-ref",
  "unknown"
];

test("redactText masks email phone ssn and card patterns", () => {
  const out = redactText("Email person@example.com phone 212-555-1212 ssn 123-45-6789");
  assert.doesNotMatch(out, /person@example\.com/);
  assert.match(out, /\[phone:redacted\]/);
  assert.match(out, /\[ssn:blocked\]/);
});

test("redactEmail keeps first character and domain", () => {
  assert.match(redactEmail("person@example.com"), /^p\*+@example\.com$/);
});

test("redactIdentifier covers every identifier category", () => {
  for (const category of CATEGORIES) {
    const out = redactIdentifier(category, "sensitive-value person@example.com");
    assert.doesNotMatch(out, /person@example\.com/);
    if (category === "ssn" || category === "password" || category === "government-id") {
      assert.match(out, /blocked/);
    }
  }
});

test("detectForbiddenSecrets flags ssn and payment card patterns", () => {
  assert.deepEqual(detectForbiddenSecrets("no secrets"), []);
  assert.ok(detectForbiddenSecrets("ssn 123-45-6789").includes("full-ssn"));
  assert.ok(detectForbiddenSecrets("4111 1111 1111 1111").includes("payment-card"));
});