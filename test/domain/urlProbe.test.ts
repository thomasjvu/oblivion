import test from "node:test";
import assert from "node:assert/strict";
import { probeOfficialUrl } from "../../src/domain/urlProbe.js";

const originalFetch = globalThis.fetch;

test("probeOfficialUrl reports reachable official URLs", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const result = await probeOfficialUrl("https://example.com/opt-out");
    assert.equal(result.reachable, true);
    assert.equal(result.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeOfficialUrl reports unreachable URLs after failed requests", async () => {
  globalThis.fetch = async () => {
    throw new Error("network-down");
  };
  try {
    const result = await probeOfficialUrl("https://offline.example/opt-out");
    assert.equal(result.reachable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});