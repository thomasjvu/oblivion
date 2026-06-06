import test from "node:test";
import assert from "node:assert/strict";
import {
  executorMode,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isX402Configured,
  oneShotDemoFallbackEnabled
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