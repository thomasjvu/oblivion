import test from "node:test";
import assert from "node:assert/strict";
import {
  firstLastSlugInPath,
  isJunkDiscoveryUrl,
  isProfileLikePath,
  nameSlugVariants,
  scoreDiscoveryCandidate
} from "../../src/domain/discoveryHeuristics.js";

const thomasScope = {
  personLabel: "Thomas J. Vu",
  aliases: [],
  approvedIdentifierLabels: ["Boston, MA"],
  sensitiveConstraints: []
};

test("nameSlugVariants derives hyphenated name forms", () => {
  const variants = nameSlugVariants("Thomas J. Vu");
  assert.ok(variants.includes("thomas-j-vu"));
  assert.ok(variants.includes("thomas-vu"));
});

test("firstLastSlugInPath accepts middle-initial profile slugs", () => {
  assert.equal(
    firstLastSlugInPath("/name/thomas-j-vu_ma/boston", ["Thomas J. Vu"]),
    true
  );
  assert.equal(firstLastSlugInPath("/people/thomas-smith", ["Thomas Vu"]), false);
});

test("isJunkDiscoveryUrl rejects opt-out and search pages", () => {
  assert.equal(isJunkDiscoveryUrl("https://www.whitepages.com/suppression-requests"), true);
  assert.equal(isJunkDiscoveryUrl("https://www.fastbackgroundcheck.com/do-not-sell"), true);
  assert.equal(isJunkDiscoveryUrl("https://www.spokeo.com/search?fname=John"), true);
  assert.equal(isJunkDiscoveryUrl("https://www.spokeo.com/"), true);
});

test("isProfileLikePath accepts people-search profile paths", () => {
  assert.equal(isProfileLikePath("https://www.fastpeoplesearch.com/name/thomas-vu_ma/boston"), true);
  assert.equal(isProfileLikePath("https://www.spokeo.com/Thomas-Vu/Boston-MA"), true);
  assert.equal(isProfileLikePath("https://www.whitepages.com/"), false);
});

test("scoreDiscoveryCandidate promotes slug profile URLs to likely", () => {
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.fastpeoplesearch.com/name/thomas-j-vu_ma/boston",
      title: "Background report",
      snippet: "Boston area listing"
    },
    thomasScope
  );
  assert.equal(scored.matchScore, "likely");
  assert.match(scored.matchReason, /profile|city\/state/i);
  assert.ok(scored.confidencePercent >= 90);
});

test("scoreDiscoveryCandidate does not promote wrong surname paths to likely", () => {
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.fastpeoplesearch.com/name/thomas-smith_ma/boston",
      title: "Thomas Smith background report",
      snippet: "Boston area listing"
    },
    thomasScope
  );
  assert.notEqual(scored.matchScore, "likely");
});

test("scoreDiscoveryCandidate does not promote snippet-only first-name hits to likely", () => {
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.spokeo.com/people-search",
      title: "Thomas listings in California",
      snippet: "Browse Thomas profiles"
    },
    thomasScope
  );
  assert.notEqual(scored.matchScore, "likely");
});

test("scoreDiscoveryCandidate promotes full name and region in listing text", () => {
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.beenverified.com/profile/abc123",
      title: "Thomas J. Vu in Boston, MA",
      snippet: "Public records for Thomas J. Vu"
    },
    thomasScope
  );
  assert.equal(scored.matchScore, "likely");
  assert.match(scored.matchReason, /location|city\/state/i);
  assert.ok(scored.confidencePercent >= 80);
});

test("scoreDiscoveryCandidate demotes homonym directory pages when city and state are required", () => {
  const sfScope = {
    personLabel: "Thomas Vu",
    aliases: [],
    approvedIdentifierLabels: ["San Francisco, CA"],
    sensitiveConstraints: ["San Francisco, CA"]
  };
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.spokeo.com/Thomas-Vu/California",
      title: "Thomas Vu, California (392 matches): Phone Number, Email, Address - Spokeo",
      snippet: "Resides in Eureka, CA"
    },
    sfScope
  );
  assert.notEqual(scored.matchScore, "likely");
});

test("state abbreviation matching ignores substrings inside names like thomas", () => {
  const scope = {
    personLabel: "Thomas Vu",
    aliases: [],
    approvedIdentifierLabels: ["Boston, MA"],
    sensitiveConstraints: ["Boston, MA"]
  };
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.beenverified.com/people/thomas-vu/",
      title: "Thomas Vu Phone Number, Address, Email & More | BeenVerified",
      snippet: "Thomas Vu address in Broken Arrow, Oklahoma 74012"
    },
    scope
  );
  assert.notEqual(scored.matchScore, "likely");
});

test("scoreDiscoveryCandidate promotes fastbackgroundcheck profile with aligned city and state", () => {
  const sfScope = {
    personLabel: "Thomas Vu",
    aliases: [],
    approvedIdentifierLabels: ["San Francisco, CA"],
    sensitiveConstraints: ["San Francisco, CA"]
  };
  const scored = scoreDiscoveryCandidate(
    {
      sourceUrl: "https://www.fastbackgroundcheck.com/people/thomas-vu/id/f-7937049323962049052",
      title: "Thomas Vu in San Francisco, CA",
      snippet: "San Francisco, California profile"
    },
    sfScope
  );
  assert.equal(scored.matchScore, "likely");
  assert.ok(scored.confidencePercent >= 85);
});