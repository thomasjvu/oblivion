import test from "node:test";
import assert from "node:assert/strict";
import {
  brokerForUrl,
  buildBraveSearchQuery,
  describeDiscoveryPlan,
  discoverExposureCandidates,
  normalizeDiscoveryUrl
} from "../src/domain/exposureDiscovery.js";

const originalFetch = globalThis.fetch;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;
const originalVeniceKey = process.env.VENICE_API_KEY;

test("normalizeDiscoveryUrl accepts bare hosts and dedupes paths", () => {
  assert.equal(
    normalizeDiscoveryUrl("https://www.fastbackgroundcheck.com/people/john-smith/id/x"),
    "https://www.fastbackgroundcheck.com/people/john-smith/id/x"
  );
  assert.equal(normalizeDiscoveryUrl("not a url"), null);
});

test("brokerForUrl maps known people-search hosts", () => {
  const broker = brokerForUrl("https://rocketreach.co/john-smith-email_example");
  assert.equal(broker?.brokerId, "rocketreach");
});

test("buildBraveSearchQuery uses redacted scope labels only", () => {
  const query = buildBraveSearchQuery({
    personLabel: "John Smith",
    aliases: ["J. Smith"],
    approvedIdentifierLabels: ["city-state"],
    sensitiveConstraints: ["New York"]
  });
  assert.match(query, /John Smith/);
  assert.doesNotMatch(query, /555-|@example/);
});

test("discoverExposureCandidates merges pasted URLs without Brave", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.VENICE_API_KEY;
  const exposures = await discoverExposureCandidates({
    caseId: "case_test",
    scope: {
      personLabel: "John Smith",
      aliases: ["J. Smith"],
      approvedIdentifierLabels: ["city-state"],
      sensitiveConstraints: []
    },
    pastedUrls: [
      "https://www.fastbackgroundcheck.com/people/john-smith/id/f-example123",
      "https://thatsthem.com/name/John-Smith"
    ]
  });
  assert.equal(exposures.length, 2);
  assert.equal(exposures[0].matchStatus, "pending");
  assert.equal(exposures.some((item) => item.brokerId === "fastbackgroundcheck"), true);
});

test("discoverExposureCandidates uses Brave results when configured", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  delete process.env.VENICE_API_KEY;
  globalThis.fetch = async (url) => {
    if (String(url).includes("search.brave.com")) {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                url: "https://www.anywho.com/people/john+smith/new+york",
                title: "John Smith in New York",
                description: "People search listing"
              },
              {
                url: "https://example.com/john-smith-profile",
                title: "John Smith",
                description: "Unrelated profile"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url);
  };
  try {
    const exposures = await discoverExposureCandidates({
      caseId: "case_brave",
      scope: {
        personLabel: "John Smith",
        aliases: [],
        approvedIdentifierLabels: ["city-state"],
        sensitiveConstraints: ["New York"]
      }
    });
    assert.ok(exposures.some((item) => item.sourceUrl.includes("anywho.com")));
    assert.ok(!exposures.some((item) => item.sourceUrl.includes("john-smith")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalVeniceKey;
  }
});

test("describeDiscoveryPlan explains broker sweep and manual fallback", () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  const manual = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: [], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 0,
    brokerSweep: true
  });
  assert.equal(manual.canAutoDiscover, false);
  assert.equal(manual.methods.some((item) => item.id === "manual-only"), true);

  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  const automated = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: ["J. Smith"], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 2,
    brokerSweep: true
  });
  assert.equal(automated.canAutoDiscover, true);
  assert.equal(automated.methods.some((item) => item.id === "pasted-urls"), true);
  assert.equal(automated.methods.some((item) => item.id === "broker-sweep"), true);
  assert.equal(automated.methods.some((item) => item.id === "web-search"), true);
  if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
});