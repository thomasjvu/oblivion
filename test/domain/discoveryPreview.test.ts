import assert from "node:assert/strict";
import test from "node:test";
import { previewDailyLimit } from "../../src/domain/discoveryPreview.js";

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