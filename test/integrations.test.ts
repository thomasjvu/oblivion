import test from "node:test";
import assert from "node:assert/strict";
import {
  executorMode,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isOneShotLiveReady,
  isX402Configured,
  oneShotDemoFallbackEnabled,
  veniceDemoFallbackEnabled
} from "../src/domain/integrations.js";

test("integration env helpers reflect executor and adapter flags", () => {
  const priorExecutor = process.env.OBLIVION_EXECUTOR_MODE;
  const priorPayTo = process.env.X402_PAY_TO;
  const priorEnabled = process.env.X402_ENABLED;
  const priorBase = process.env.ONESHOT_BASE_URL;
  try {
    delete process.env.OBLIVION_EXECUTOR_MODE;
    assert.equal(executorMode(), "record-only");
    assert.equal(isLiveExecutorEnabled(), false);

    process.env.OBLIVION_EXECUTOR_MODE = "live";
    assert.equal(isLiveExecutorEnabled(), true);

    delete process.env.X402_PAY_TO;
    process.env.X402_ENABLED = "true";
    assert.equal(isX402Configured(), false);

    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    assert.equal(isX402Configured(), true);

    delete process.env.ONESHOT_BASE_URL;
    assert.equal(isOneShotConfigured(), true);

    process.env.ONESHOT_BASE_URL = "";
    assert.equal(isOneShotConfigured(), false);
  } finally {
    if (priorExecutor === undefined) delete process.env.OBLIVION_EXECUTOR_MODE;
    else process.env.OBLIVION_EXECUTOR_MODE = priorExecutor;
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
    if (priorEnabled === undefined) delete process.env.X402_ENABLED;
    else process.env.X402_ENABLED = priorEnabled;
    if (priorBase === undefined) delete process.env.ONESHOT_BASE_URL;
    else process.env.ONESHOT_BASE_URL = priorBase;
  }
});

test("venice demo fallback defaults on outside production", () => {
  const prior = process.env.VENICE_DEMO_FALLBACK;
  const priorNode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.VENICE_DEMO_FALLBACK;
    assert.equal(veniceDemoFallbackEnabled(), false);
    process.env.VENICE_DEMO_FALLBACK = "true";
    assert.equal(veniceDemoFallbackEnabled(), true);
    delete process.env.VENICE_DEMO_FALLBACK;
    process.env.NODE_ENV = "development";
    assert.equal(veniceDemoFallbackEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.VENICE_DEMO_FALLBACK;
    else process.env.VENICE_DEMO_FALLBACK = prior;
    if (priorNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNode;
  }
});

test("oneshot live readiness requires API key and disabled demo fallback", () => {
  const priorKey = process.env.ONESHOT_API_KEY;
  const priorDemo = process.env.ONESHOT_DEMO_FALLBACK;
  const priorBase = process.env.ONESHOT_BASE_URL;
  try {
    delete process.env.ONESHOT_API_KEY;
    delete process.env.ONESHOT_DEMO_FALLBACK;
    assert.equal(isOneShotLiveReady(), false);
    process.env.ONESHOT_API_KEY = "test-key";
    assert.equal(isOneShotLiveReady(), true);
    process.env.ONESHOT_DEMO_FALLBACK = "true";
    assert.equal(isOneShotLiveReady(), false);
  } finally {
    if (priorKey === undefined) delete process.env.ONESHOT_API_KEY;
    else process.env.ONESHOT_API_KEY = priorKey;
    if (priorDemo === undefined) delete process.env.ONESHOT_DEMO_FALLBACK;
    else process.env.ONESHOT_DEMO_FALLBACK = priorDemo;
    if (priorBase === undefined) delete process.env.ONESHOT_BASE_URL;
    else process.env.ONESHOT_BASE_URL = priorBase;
  }
});

test("oneshot demo fallback is opt-in via ONESHOT_DEMO_FALLBACK", () => {
  const prior = process.env.ONESHOT_DEMO_FALLBACK;
  try {
    delete process.env.ONESHOT_DEMO_FALLBACK;
    assert.equal(oneShotDemoFallbackEnabled(), false);
    process.env.ONESHOT_DEMO_FALLBACK = "true";
    assert.equal(oneShotDemoFallbackEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.ONESHOT_DEMO_FALLBACK;
    else process.env.ONESHOT_DEMO_FALLBACK = prior;
  }
});