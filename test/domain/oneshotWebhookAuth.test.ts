import assert from "node:assert/strict";
import test from "node:test";
import {
  signOneShotWebhookProbe,
  verifyOneShotWebhookSignature
} from "../../src/domain/oneshotWebhookAuth.js";

test("verifyOneShotWebhookSignature validates HMAC of raw body", () => {
  const original = process.env.ONESHOT_WEBHOOK_SECRET;
  process.env.ONESHOT_WEBHOOK_SECRET = "test-webhook-secret";
  try {
    const rawBody = JSON.stringify({ eventName: "submitted", taskId: "task_1" });
    const signature = signOneShotWebhookProbe(rawBody);
    assert.ok(verifyOneShotWebhookSignature(rawBody, signature));
    assert.equal(verifyOneShotWebhookSignature(rawBody, "wrong-signature"), false);
    assert.equal(verifyOneShotWebhookSignature(rawBody, "test-webhook-secret"), false);
  } finally {
    if (original === undefined) delete process.env.ONESHOT_WEBHOOK_SECRET;
    else process.env.ONESHOT_WEBHOOK_SECRET = original;
  }
});