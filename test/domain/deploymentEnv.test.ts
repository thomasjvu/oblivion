import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionSafety } from "../../src/domain/deploymentEnv.js";

test("assertProductionSafety rejects payment bypass flags in production", () => {
  const originalEnv = process.env.OBLIVION_DEPLOYMENT_ENV;
  const originalBypass = process.env.OBLIVION_CREDITS_BYPASS;
  process.env.OBLIVION_DEPLOYMENT_ENV = "production";
  process.env.OBLIVION_CREDITS_BYPASS = "true";
  try {
    assert.throws(() => assertProductionSafety(), /OBLIVION_CREDITS_BYPASS/);
  } finally {
    if (originalEnv === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = originalEnv;
    if (originalBypass === undefined) delete process.env.OBLIVION_CREDITS_BYPASS;
    else process.env.OBLIVION_CREDITS_BYPASS = originalBypass;
  }
});