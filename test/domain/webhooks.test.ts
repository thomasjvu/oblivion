import assert from "node:assert/strict";
import test from "node:test";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_RETRY_ENABLED
} from "../../src/domain/webhooks.js";

test("verifyWebhookSignature accepts valid HMAC", () => {
  const secret = "whsec_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ event: "case.created", data: { caseId: "case_1" } });
  const signature = signWebhookPayload(secret, timestamp, body);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature), true);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, "bad"), false);
});

test("webhook retry config exposes sane defaults", () => {
  assert.equal(WEBHOOK_RETRY_ENABLED, true);
  assert.ok(WEBHOOK_MAX_RETRIES >= 1);
  assert.ok(WEBHOOK_RETRY_BASE_MS >= 1000);
});

function scheduleNextRetry(attemptCount: number): string | undefined {
  if (!WEBHOOK_RETRY_ENABLED || attemptCount >= WEBHOOK_MAX_RETRIES) return undefined;
  const delayMs = WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
  return new Date(Date.now() + delayMs).toISOString();
}

test("scheduleNextRetry backs off until max retries", () => {
  const first = scheduleNextRetry(1);
  const last = scheduleNextRetry(WEBHOOK_MAX_RETRIES);
  assert.ok(first);
  assert.equal(last, undefined);
});