import test from "node:test";
import assert from "node:assert/strict";
import { probeBrokerOptOutForm } from "../../src/domain/brokerWebForm.js";

const originalFetch = globalThis.fetch;

test("probeBrokerOptOutForm detects form fields without transmitting PII", async () => {
  globalThis.fetch = async () =>
    new Response(
      '<html><form action="/submit" method="post"><input name="email"/><input name="url"/></form></html>',
      { status: 200 }
    );
  const probe = await probeBrokerOptOutForm("https://example.invalid/opt-out");
  assert.equal(probe.reachable, true);
  assert.equal(probe.formCount, 1);
  assert.deepEqual(probe.fieldNames, ["email", "url"]);
  assert.match(probe.summary, /Detected 1 form/);
  globalThis.fetch = originalFetch;
});

test("probeBrokerOptOutForm reports unreachable pages", async () => {
  globalThis.fetch = async () => {
    throw new Error("network");
  };
  const probe = await probeBrokerOptOutForm("https://example.invalid/opt-out");
  assert.equal(probe.reachable, false);
  globalThis.fetch = originalFetch;
});