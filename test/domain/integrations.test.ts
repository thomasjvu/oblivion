import test from "node:test";
import assert from "node:assert/strict";
import {
  executorMode,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isOneShotLiveReady,
  isX402Configured,
  oneShotWebhookDestinationUrl
} from "../../src/domain/integrations.js";

test("integration env helpers reflect executor and adapter flags", () => {
  const priorExecutor = process.env.OBLIVION_EXECUTOR_MODE;
  const priorDeployment = process.env.OBLIVION_DEPLOYMENT_ENV;
  const priorPayTo = process.env.X402_PAY_TO;
  const priorEnabled = process.env.X402_ENABLED;
  const priorBase = process.env.ONESHOT_BASE_URL;
  const priorApiUrl = process.env.OBLIVION_PUBLIC_API_URL;
  try {
    process.env.OBLIVION_DEPLOYMENT_ENV = "development";
    delete process.env.OBLIVION_EXECUTOR_MODE;
    assert.equal(executorMode(), "record-only");
    assert.equal(isLiveExecutorEnabled(), false);

    process.env.OBLIVION_DEPLOYMENT_ENV = "production";
    delete process.env.OBLIVION_EXECUTOR_MODE;
    assert.equal(executorMode(), "live");
    assert.equal(isLiveExecutorEnabled(), true);

    process.env.OBLIVION_EXECUTOR_MODE = "record-only";
    assert.equal(executorMode(), "record-only");

    delete process.env.X402_PAY_TO;
    delete process.env.X402_ENABLED;
    assert.equal(isX402Configured(), false);

    process.env.X402_PAY_TO = "0x0000000000000000000000000000000000000000";
    assert.equal(isX402Configured(), false);

    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
    assert.equal(isX402Configured(), true);

    delete process.env.ONESHOT_BASE_URL;
    assert.equal(isOneShotConfigured(), true);

    process.env.ONESHOT_BASE_URL = "";
    assert.equal(isOneShotConfigured(), false);

    delete process.env.OBLIVION_PUBLIC_API_URL;
    assert.throws(() => oneShotWebhookDestinationUrl("case_test"), /OBLIVION_PUBLIC_API_URL/);
    process.env.OBLIVION_PUBLIC_API_URL = "https://api.example.com";
    assert.equal(
      oneShotWebhookDestinationUrl("case_test", "payment_1"),
      "https://api.example.com/api/1shot/webhook?caseId=case_test&sessionId=payment_1"
    );
  } finally {
    if (priorExecutor === undefined) delete process.env.OBLIVION_EXECUTOR_MODE;
    else process.env.OBLIVION_EXECUTOR_MODE = priorExecutor;
    if (priorDeployment === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = priorDeployment;
    if (priorPayTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = priorPayTo;
    if (priorEnabled === undefined) delete process.env.X402_ENABLED;
    else process.env.X402_ENABLED = priorEnabled;
    if (priorBase === undefined) delete process.env.ONESHOT_BASE_URL;
    else process.env.ONESHOT_BASE_URL = priorBase;
    if (priorApiUrl === undefined) delete process.env.OBLIVION_PUBLIC_API_URL;
    else process.env.OBLIVION_PUBLIC_API_URL = priorApiUrl;
  }
});

test("oneshot live readiness requires API key", () => {
  const priorKey = process.env.ONESHOT_API_KEY;
  const priorBase = process.env.ONESHOT_BASE_URL;
  try {
    delete process.env.ONESHOT_API_KEY;
    assert.equal(isOneShotLiveReady(), false);
    process.env.ONESHOT_API_KEY = "test-key";
    assert.equal(isOneShotLiveReady(), true);
  } finally {
    if (priorKey === undefined) delete process.env.ONESHOT_API_KEY;
    else process.env.ONESHOT_API_KEY = priorKey;
    if (priorBase === undefined) delete process.env.ONESHOT_BASE_URL;
    else process.env.ONESHOT_BASE_URL = priorBase;
  }
});