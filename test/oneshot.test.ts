import test from "node:test";
import assert from "node:assert/strict";
import { relayOneShotForCase } from "../src/domain/oneshot.js";

const originalFetch = globalThis.fetch;

test("relayOneShotForCase polls task status over JSON-RPC", async () => {
  process.env.ONESHOT_BASE_URL = "https://relayer.test/relayers";
  process.env.ONESHOT_DEMO_FALLBACK = "false";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "Confirmed", txHash: "0xabc", userOpHash: "0xdef" }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    const relay = await relayOneShotForCase({
      caseId: "case_test",
      taskId: "task_123"
    });
    assert.equal(relay.mode, "live");
    assert.equal(relay.events.at(-1)?.status, "confirmed");
    assert.equal(relay.events.at(-1)?.txHash, "0xabc");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ONESHOT_BASE_URL;
    delete process.env.ONESHOT_DEMO_FALLBACK;
  }
});