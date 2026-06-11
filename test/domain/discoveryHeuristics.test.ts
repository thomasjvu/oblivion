import test from "node:test";
import assert from "node:assert/strict";
import {
  isJunkDiscoveryUrl,
  isProfileLikePath,
  nameSlugVariants,
  scoreDiscoveryCandidate
} from "../../src/domain/discoveryHeuristics.js";

test("nameSlugVariants derives hyphenated name forms", () => {
  const variants = nameSlugVariants("Thomas J. Vu");
  assert.ok(variants.includes("thomas-j-vu"));
  assert.ok(variants.includes("thomas-vu"));
});

test("isJunkDiscoveryUrl rejects opt-out and search pages", () => {
  assert.equal(isJunkDiscoveryUrl("https://www.whitepages.com/suppression-requests"), true);
  assert.equal(isJunkDiscoveryUrl("https://www.spokeo.com/search?fname=John"), true);
  assert.equal(isJunkDiscoveryUrl("https://www.spokeo.com/"), true);
});

test("isProfileLikePath accepts people-search profile paths", () => {
  assert.equal(isProfileLikePath("https://www.fastpeoplesearch.com/name/thomas-vu_ma/boston"), true);
  assert.equal(isProfileLikePath("https://www.whitepages.com/"), false);
});

test("scoreDiscoveryCandidate promotes slug profile URLs to likely", () => {
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.fastpeoplesearch.com/name/thomas-j-vu_ma/boston",
      title: "Background report",
      snippet: "Boston area listing"
    },
    {
      personLabel: "Thomas J. Vu",
      aliases: [],
      approvedIdentifierLabels: ["Boston, MA"],
      sensitiveConstraints: []
    }
  );
  assert.equal(scored.matchScore, "likely");
  assert.match(scored.matchReason, /slug|profile|name/i);
});