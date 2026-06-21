import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeOutboundHttpsUrl,
  assertSafePartnerInboxUrl,
  isSafeOutboundHttpsUrl,
  safeOutboundFetch
} from "../../src/domain/safeOutboundUrl.js";
import { DomainError } from "../../src/domain/errors.js";

test("assertSafeOutboundHttpsUrl allows public https hosts", () => {
  assert.doesNotThrow(() => assertSafeOutboundHttpsUrl("https://partner.example/callback"));
});

test("assertSafeOutboundHttpsUrl blocks loopback and metadata hosts", () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://10.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[::ffff:169.254.169.254]/meta"
  ]) {
    assert.throws(() => assertSafeOutboundHttpsUrl(url), DomainError);
    assert.equal(isSafeOutboundHttpsUrl(url), false);
  }
});

test("assertSafePartnerInboxUrl blocks metadata hosts disguised as inbox paths", () => {
  assert.throws(
    () => assertSafePartnerInboxUrl("https://169.254.169.254/v1/partners/p1/webhook-inbox"),
    DomainError
  );
});

test("safeOutboundFetch blocks redirect chains to private hosts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target === "https://public.example/start") {
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/internal" } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => safeOutboundFetch("https://public.example/start"),
      (error: unknown) => error instanceof DomainError && error.code === "outbound-url-blocked"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});