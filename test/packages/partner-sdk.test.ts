import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyOblivionWebhook } from "../../packages/partner-sdk/webhooks.js";

function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

test("verifyOblivionWebhook accepts valid HMAC signatures", async () => {
  const secret = "whsec_partner_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ event: "case.created", data: { caseId: "case_1" } });
  const signature = signPayload(secret, timestamp, body);

  assert.equal(await verifyOblivionWebhook(secret, timestamp, body, signature), true);
  assert.equal(await verifyOblivionWebhook(secret, timestamp, body, "bad-signature"), false);
});

test("verifyOblivionWebhook rejects stale timestamps", async () => {
  const secret = "whsec_partner_test";
  const timestamp = String(Math.floor(Date.now() / 1000) - 600);
  const body = JSON.stringify({ event: "approval.pending" });
  const signature = signPayload(secret, timestamp, body);

  assert.equal(await verifyOblivionWebhook(secret, timestamp, body, signature, 300), false);
});