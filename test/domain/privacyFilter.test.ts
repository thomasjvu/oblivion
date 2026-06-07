import test from "node:test";
import assert from "node:assert/strict";
import { expandNameTerms, maskPrivacyText, PRIVACY_MASK } from "../../src/domain/privacyFilter.js";

test("maskPrivacyText replaces name and alias occurrences with asterisks", () => {
  const terms = expandNameTerms("John Smith", ["J. Smith"], ["New York"]);
  const masked = maskPrivacyText(
    "John Smith in New York — also known as J. Smith. Profile: /people/john-smith/",
    terms
  );
  assert.equal(masked.includes("John Smith"), false);
  assert.equal(masked.includes("J. Smith"), false);
  assert.equal(masked.includes("john-smith"), false);
  assert.ok(masked.split(PRIVACY_MASK).length >= 4);
});

test("maskPrivacyText leaves text unchanged when filter terms are empty", () => {
  assert.equal(maskPrivacyText("Jane Doe", []), "Jane Doe");
});