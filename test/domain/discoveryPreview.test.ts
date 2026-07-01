import assert from "node:assert/strict";
import test from "node:test";
import { dedupePreviewCandidatesByBroker, previewDailyLimit } from "../../src/domain/discoveryPreview.js";

test("previewDailyLimit defaults to 5 in production when env unset", () => {
  const originalEnv = process.env.OBLIVION_DEPLOYMENT_ENV;
  const originalLimit = process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  process.env.OBLIVION_DEPLOYMENT_ENV = "production";
  try {
    assert.equal(previewDailyLimit(), 5);
  } finally {
    if (originalEnv === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = originalEnv;
    if (originalLimit === undefined) delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
    else process.env.OBLIVION_PREVIEW_DAILY_LIMIT = originalLimit;
  }
});

test("dedupePreviewCandidatesByBroker keeps the first candidate per broker", () => {
  const deduped = dedupePreviewCandidatesByBroker([
    {
      sourceUrl: "https://www.spokeo.com/thomas-vu/boston-ma",
      brokerId: "spokeo",
      brokerLabel: "Spokeo",
      matchScore: "likely",
      matchReason: "first",
      confidencePercent: 96
    },
    {
      sourceUrl: "https://www.spokeo.com/thomas-vu/new-york-ny",
      brokerId: "spokeo",
      brokerLabel: "Spokeo",
      matchScore: "likely",
      matchReason: "second",
      confidencePercent: 91
    },
    {
      sourceUrl: "https://www.beenverified.com/people/thomas-vu/",
      brokerId: "beenverified",
      brokerLabel: "BeenVerified",
      matchScore: "likely",
      matchReason: "third",
      confidencePercent: 89
    }
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.brokerId, "spokeo");
  assert.equal(deduped[1]?.brokerId, "beenverified");
});

test("previewDailyLimit stays unlimited in development when env unset", () => {
  const originalEnv = process.env.OBLIVION_DEPLOYMENT_ENV;
  const originalLimit = process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  process.env.OBLIVION_DEPLOYMENT_ENV = "development";
  try {
    assert.equal(previewDailyLimit(), 0);
  } finally {
    if (originalEnv === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = originalEnv;
    if (originalLimit === undefined) delete process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
    else process.env.OBLIVION_PREVIEW_DAILY_LIMIT = originalLimit;
  }
});