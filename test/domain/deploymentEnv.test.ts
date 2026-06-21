import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionSafety } from "../../src/domain/deploymentEnv.js";

test("assertProductionSafety rejects HACKATHON_MODE in production", () => {
  const originalEnv = process.env.OBLIVION_DEPLOYMENT_ENV;
  const originalHackathon = process.env.HACKATHON_MODE;
  process.env.OBLIVION_DEPLOYMENT_ENV = "production";
  process.env.HACKATHON_MODE = "true";
  try {
    assert.throws(() => assertProductionSafety(), /HACKATHON_MODE/);
  } finally {
    if (originalEnv === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = originalEnv;
    if (originalHackathon === undefined) delete process.env.HACKATHON_MODE;
    else process.env.HACKATHON_MODE = originalHackathon;
  }
});

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