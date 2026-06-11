import test from "node:test";
import assert from "node:assert/strict";
import { runDiscoveryPreview } from "../../src/domain/discoveryPreview.js";

const originalFetch = globalThis.fetch;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;

function installBraveMock(handler: (url: string) => unknown) {
  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  delete process.env.VENICE_API_KEY;
  globalThis.fetch = async (url) => {
    if (String(url).includes("search.brave.com")) {
      const payload = handler(String(url));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return originalFetch(url);
  };
}

test("runDiscoveryPreview merges broad search when broker sweep is empty", async () => {
  installBraveMock((url) => {
    if (url.includes("site%3A") || url.includes("site:")) {
      return { web: { results: [] } };
    }
    return {
      web: {
        results: [
          {
            url: "https://www.truepeoplesearch.com/find/thomas-vu/boston-ma",
            title: "Thomas Vu in Boston",
            description: "People search listing"
          },
          {
            url: "https://example.com/not-a-broker",
            title: "Ignore me",
            description: "Unrelated"
          }
        ]
      }
    };
  });

  try {
    const preview = await runDiscoveryPreview({
      personLabel: "Thomas Vu",
      regionLabel: "Boston, MA",
      sweepLimit: 2
    });
    assert.ok(preview.candidates.length >= 1);
    assert.equal(preview.stats.broadSearchHits, 1);
    assert.equal(preview.stats.sweepHits, 0);
    assert.ok(preview.candidates.some((item) => item.brokerId === "truepeoplesearch"));
    assert.ok(preview.candidates.every((item) => item.matchScore !== "unlikely"));
    assert.ok(preview.candidates[0].matchReason);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
  }
});

test("runDiscoveryPreview filters junk broker pages", async () => {
  installBraveMock(() => ({
    web: {
      results: [
        {
          url: "https://www.radaris.com/opt-out",
          title: "Opt out",
          description: "Privacy"
        },
        {
          url: "https://www.fastpeoplesearch.com/name/thomas-vu_ma",
          title: "Thomas Vu",
          description: "Profile"
        }
      ]
    }
  }));

  try {
    const preview = await runDiscoveryPreview({
      personLabel: "Thomas Vu",
      regionLabel: "Massachusetts",
      sweepLimit: 1
    });
    assert.ok(preview.candidates.every((item) => !item.sourceUrl.includes("/opt-out")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
  }
});