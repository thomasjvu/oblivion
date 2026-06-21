import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { clientIp, trustProxyHeaders } from "../../src/api/clientIp.js";

function mockRequest(headers: Record<string, string | string[]>, remoteAddress = "10.0.0.5"): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress }
  } as IncomingMessage;
}

test("clientIp ignores X-Forwarded-For unless OBLIVION_TRUST_PROXY=true", () => {
  const original = process.env.OBLIVION_TRUST_PROXY;
  delete process.env.OBLIVION_TRUST_PROXY;
  assert.equal(trustProxyHeaders(), false);
  assert.equal(
    clientIp(mockRequest({ "x-forwarded-for": "203.0.113.9" })),
    "10.0.0.5"
  );

  process.env.OBLIVION_TRUST_PROXY = "true";
  assert.equal(trustProxyHeaders(), true);
  assert.equal(
    clientIp(mockRequest({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    "203.0.113.9"
  );

  if (original === undefined) delete process.env.OBLIVION_TRUST_PROXY;
  else process.env.OBLIVION_TRUST_PROXY = original;
});