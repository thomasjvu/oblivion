import test from "node:test";
import assert from "node:assert/strict";
import {
  hostFromDestination,
  resolveHostAbuseContact,
  sendPlatformAbuseNotice
} from "../src/domain/platformAbuse.js";

const originalFetch = globalThis.fetch;

test("resolveHostAbuseContact maps known hosts and infers abuse@ for others", () => {
  const reddit = resolveHostAbuseContact("reddit.com", "https://www.reddit.com/r/test/comments/abc");
  assert.equal(reddit?.email, "abuse@reddit.com");
  assert.equal(reddit?.inferred, false);

  const unknown = resolveHostAbuseContact("example-host.net");
  assert.equal(unknown?.email, "abuse@example-host.net");
  assert.equal(unknown?.inferred, true);
});

test("hostFromDestination normalizes URLs and bare hosts", () => {
  assert.equal(hostFromDestination("https://www.github.com/repo"), "github.com");
  assert.equal(hostFromDestination("twitter.com"), "twitter.com");
});

test("sendPlatformAbuseNotice uses transactional email when Resend is configured", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.SMTP_FROM = "agent@example.com";
  let postedBody = "";
  globalThis.fetch = async (_url, init) => {
    postedBody = String(init?.body || "");
    return new Response(JSON.stringify({ id: "email_abuse_1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await sendPlatformAbuseNotice({
      action: {
        id: "action_1",
        caseId: "case_1",
        actionType: "platform-abuse-report",
        destination: "reddit.com",
        template: "platform-abuse-report.md",
        draftText: "",
        expectedConfirmationStep: "approve",
        approvalId: "approval_1",
        executionStatus: "ready",
        createdAt: new Date().toISOString()
      },
      approval: {
        id: "approval_1",
        caseId: "case_1",
        actionType: "platform-abuse-report",
        destination: "reddit.com",
        identifiersApproved: ["email"],
        dataToDisclose: ["email", "infringing-url"],
        purpose: "Remove unauthorized copy",
        disclosureRisk: "host contact",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "approved",
        createdAt: new Date().toISOString()
      },
      contact: { host: "reddit.com", email: "abuse@reddit.com", inferred: false },
      infringingUrl: "https://reddit.com/r/test/comments/abc",
      emailLabel: "person@example.com"
    });
    assert.equal(result.ok, true);
    assert.match(postedBody, /abuse@reddit\.com/);
    assert.match(postedBody, /person@example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_FROM;
  }
});