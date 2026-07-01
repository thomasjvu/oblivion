import test from "node:test";
import assert from "node:assert/strict";
import { post, startTestServer } from "../helpers/http.js";

const originalLimit = process.env.OBLIVION_PREVIEW_DAILY_LIMIT;

test("discovery preview is public, unlimited by default, and does not create cases", async () => {
  delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  const { server, base, store } = await startTestServer();

  try {
    const beforeCases = store.cases.size;
    const first = await post(
      base,
      "/api/discovery/preview",
      { personLabel: "Jane Preview" },
      200
    );
    assert.ok(Array.isArray(first.candidates));
    assert.equal(first.dailyLimit, 0);
    assert.equal(first.remainingPreviews, null);
    assert.equal(store.cases.size, beforeCases);
    assert.ok(first.stats);
    assert.equal(typeof first.stats.brokersChecked, "number");
    for (const candidate of first.candidates) {
      assert.ok(candidate.sourceUrl);
      assert.equal(candidate.matchScore, "likely");
      assert.equal(typeof candidate.matchReason, "string");
      assert.ok(typeof candidate.confidencePercent === "number" && candidate.confidencePercent >= 75);
      assert.equal(candidate.accessToken, undefined);
    }
    assert.equal(typeof first.stats.candidatesShown, "number");
    assert.equal(typeof first.stats.rawHits, "number");
    assert.ok(Array.isArray(first.stats.brokersQueried));

    const second = await post(base, "/api/discovery/preview", { personLabel: "Jane Preview" }, 200);
    assert.equal(second.dailyLimit, 0);
    assert.equal(second.remainingPreviews, null);
  } finally {
    if (originalLimit === undefined) delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
    else process.env.OBLIVION_PREVIEW_DAILY_LIMIT = originalLimit;
    server.close();
  }
});

test("discovery preview can enforce a daily limit when configured", async () => {
  process.env.OBLIVION_PREVIEW_DAILY_LIMIT = "2";
  const { server, base } = await startTestServer();

  try {
    const first = await post(base, "/api/discovery/preview", { personLabel: "Jane Preview" }, 200);
    assert.equal(first.dailyLimit, 2);
    assert.equal(first.remainingPreviews, 1);

    const second = await post(base, "/api/discovery/preview", { personLabel: "Jane Preview" }, 200);
    assert.equal(second.remainingPreviews, 0);

    const third = await fetch(`${base}/api/discovery/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personLabel: "Jane Preview" })
    });
    assert.equal(third.status, 429);
    const thirdJson = await third.json();
    assert.equal(thirdJson.error, "preview-quota-exceeded");
  } finally {
    if (originalLimit === undefined) delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
    else process.env.OBLIVION_PREVIEW_DAILY_LIMIT = originalLimit;
    server.close();
  }
});

test("broker catalog list is public", async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/api/brokers`);
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.ok(Array.isArray(json.brokers));
    assert.ok(json.count >= 50);
    assert.ok(json.brokers.some((item: { brokerId: string }) => item.brokerId === "fastbackgroundcheck"));
  } finally {
    server.close();
  }
});

test("discovery preview requires person label", async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/api/discovery/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personLabel: "   " })
    });
    assert.equal(response.status, 422);
  } finally {
    server.close();
  }
});