import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import {
  brokerForUrl,
  buildBraveSearchQuery,
  describeDiscoveryPlan,
  discoverExposureCandidates,
  fetchWebSearchCandidates,
  normalizeDiscoveryUrl
} from "../../src/domain/exposureDiscovery.js";

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

test("fetchWebSearchCandidates prefers Brave when both providers are configured", async () => {
  process.env.VENICE_API_KEY = "venice-test";
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
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
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/augment/search")) {
      throw new Error("Venice search should not run when Brave succeeds");
    }
    return originalFetch(url);
  };
  try {
    const candidates = await fetchWebSearchCandidates("John Smith people search");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].origin, "brave-search");
    assert.match(candidates[0].sourceUrl, /anywho\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalVeniceKey;
  }
});

test("fetchWebSearchCandidates falls back to Venice when Brave search fails", async () => {
  process.env.VENICE_API_KEY = "venice-test";
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  globalThis.fetch = async (url) => {
    if (String(url).includes("search.brave.com")) {
      return new Response("quota exceeded", { status: 429 });
    }
    if (String(url).includes("/augment/search")) {
      return new Response(
        JSON.stringify({
          query: "John Smith people search",
          results: [
            {
              title: "John Smith in New York",
              url: "https://www.anywho.com/people/john+smith/new+york",
              content: "People search listing",
              date: ""
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url);
  };
  try {
    const candidates = await fetchWebSearchCandidates("John Smith people search");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].origin, "venice-search");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalVeniceKey;
  }
});

test("discoverExposureCandidates uses Venice search when configured", async () => {
  process.env.VENICE_API_KEY = "venice-test";
  delete process.env.BRAVE_SEARCH_API_KEY;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/augment/search")) {
      return new Response(
        JSON.stringify({
          query: "John Smith people search",
          results: [
            {
              title: "John Smith in New York",
              url: "https://www.anywho.com/people/john+smith/new+york",
              content: "People search listing",
              date: ""
            },
            {
              title: "John Smith unrelated",
              url: "https://example.com/john-smith-profile",
              content: "Unrelated profile",
              date: ""
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"matchScore":"likely","matchReason":"Name and broker host align."}' } }],
          usage: { total_tokens: 42 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url);
  };
  try {
    const exposures = await discoverExposureCandidates({
      caseId: "case_venice",
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
  delete process.env.VENICE_API_KEY;
  const manual = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: [], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 0,
    brokerSweep: true
  });
  assert.equal(manual.canAutoDiscover, false);
  assert.equal(manual.methods.some((item) => item.id === "manual-only"), true);
  assert.match(manual.methods.find((item) => item.id === "manual-only")?.detail || "", /BRAVE_SEARCH_API_KEY/);

  process.env.VENICE_API_KEY = "venice-test";
  const veniceAutomated = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: ["J. Smith"], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 2,
    brokerSweep: true
  });
  assert.equal(veniceAutomated.canAutoDiscover, true);
  assert.equal(veniceAutomated.methods.some((item) => item.id === "pasted-urls"), true);
  assert.equal(veniceAutomated.methods.some((item) => item.id === "broker-sweep"), true);
  assert.equal(veniceAutomated.methods.some((item) => item.id === "web-search"), true);
  assert.match(
    veniceAutomated.methods.find((item) => item.id === "web-search")?.detail || "",
    /Venice web search/
  );

  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  const bothAutomated = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: ["J. Smith"], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 2,
    brokerSweep: true
  });
  assert.match(
    bothAutomated.methods.find((item) => item.id === "web-search")?.detail || "",
    /Brave search \(Venice fallback\)/
  );

  delete process.env.VENICE_API_KEY;
  const braveAutomated = describeDiscoveryPlan({
    scope: { personLabel: "John Smith", aliases: ["J. Smith"], approvedIdentifierLabels: [], sensitiveConstraints: [] },
    pastedUrlCount: 2,
    brokerSweep: true
  });
  assert.equal(braveAutomated.canAutoDiscover, true);
  assert.match(
    braveAutomated.methods.find((item) => item.id === "web-search")?.detail || "",
    /Brave search/
  );
  if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
  if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = originalVeniceKey;
});

test("discoverExposureCandidates uses heuristic scoring when partner Venice budget is exhausted", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  process.env.VENICE_API_KEY = "venice-test";
  const store = new MemoryStore();
  const partnerId = "partner_no_credits";
  const now = new Date().toISOString();
  store.partners.set(partnerId, {
    id: partnerId,
    name: "No Credits Partner",
    apiKeyHash: "hash",
    environment: "sandbox",
    balanceCredits: 0,
    webhookEvents: [],
    createdAt: now,
    updatedAt: now
  });
  const caseId = "case_partner_heuristic";
  store.cases.set(caseId, {
    id: caseId,
    jurisdiction: "US",
    riskLevel: "standard",
    authorityBasis: "self",
    partnerId,
    retentionDays: 30,
    encryptedVaultPointer: "vault",
    createdAt: now,
    updatedAt: now
  });
  let chatCalls = 0;
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
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/chat/completions")) {
      chatCalls += 1;
      throw new Error("Venice chat should not run without partner credits");
    }
    return originalFetch(url);
  };
  try {
    const exposures = await discoverExposureCandidates({
      caseId,
      store,
      scope: {
        personLabel: "John Smith",
        aliases: [],
        approvedIdentifierLabels: ["city-state"],
        sensitiveConstraints: ["New York"]
      }
    });
    assert.equal(chatCalls, 0);
    assert.ok(exposures.some((item) => item.sourceUrl.includes("anywho.com")));
    assert.equal(
      exposures.find((item) => item.sourceUrl.includes("anywho.com"))?.matchReason,
      "Heuristic match from redacted labels and broker host."
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    if (originalVeniceKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalVeniceKey;
  }
});