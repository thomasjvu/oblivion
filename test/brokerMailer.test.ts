import test from "node:test";
import assert from "node:assert/strict";
import {
  isBrokerEmailConfigured,
  isResendConfigured,
  sendBrokerOptOutEmail
} from "../src/domain/brokerMailer.js";

const originalFetch = globalThis.fetch;

test("broker email readiness reflects Resend or SMTP configuration", () => {
  const priorResend = process.env.RESEND_API_KEY;
  const priorHost = process.env.SMTP_HOST;
  const priorFrom = process.env.SMTP_FROM;
  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    assert.equal(isBrokerEmailConfigured(), false);
    process.env.RESEND_API_KEY = "re_test";
    assert.equal(isResendConfigured(), true);
    assert.equal(isBrokerEmailConfigured(), true);
  } finally {
    if (priorResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = priorResend;
    if (priorHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = priorHost;
    if (priorFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = priorFrom;
  }
});

test("sendBrokerOptOutEmail posts to Resend when configured", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.SMTP_FROM = "agent@example.com";
  let posted = "";
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    posted = String(url);
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await sendBrokerOptOutEmail({
      brokerLabel: "AnyWho",
      to: "privacy@anywho.com",
      replyTo: "person@example.com",
      profileUrl: "https://anywho.com/profile",
      purpose: "Remove listing"
    });
    assert.equal(posted, "https://api.resend.com/emails");
    assert.equal(result.ok, true);
    assert.equal(result.provider, "resend");
    assert.equal(result.messageId, "email_123");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_FROM;
  }
});