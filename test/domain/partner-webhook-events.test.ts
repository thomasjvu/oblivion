import assert from "node:assert/strict";
import test from "node:test";
import { parsePartnerWebhookEvents } from "../../src/domain/partners.js";
import { DomainError } from "../../src/domain/errors.js";

test("parsePartnerWebhookEvents accepts known events", () => {
  const events = parsePartnerWebhookEvents(["case.created", "approval.pending"]);
  assert.deepEqual(events, ["case.created", "approval.pending"]);
});

test("parsePartnerWebhookEvents rejects unknown events", () => {
  assert.throws(
    () => parsePartnerWebhookEvents(["case.created", "not.real"]),
    (error: unknown) => error instanceof DomainError && error.code === "webhook-event-invalid"
  );
});