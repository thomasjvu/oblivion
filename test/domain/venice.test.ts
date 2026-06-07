import test from "node:test";
import assert from "node:assert/strict";
import { runVeniceAnalysis } from "../../src/domain/venice.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.VENICE_API_KEY;
const originalBase = process.env.VENICE_BASE_URL;

test("runVeniceAnalysis calls Venice chat API and parses JSON output", async () => {
  process.env.VENICE_API_KEY = "test-key";
  process.env.VENICE_BASE_URL = "https://api.venice.ai/api/v1";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /chat\/completions$/);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Redacted case classification",
                summary: "People-search cleanup route fits.",
                risk: "standard",
                recommendedTask: "broker-opt-out",
                nextSteps: ["Verify path", "Prepare approval"]
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const analysis = await runVeniceAnalysis({
      caseId: "case_test",
      kind: "classify-case",
      notes: "Remove person@example.com from brokers."
    });
    assert.equal(analysis.kind, "classify-case");
    assert.doesNotMatch(JSON.stringify(analysis), /person@example\.com/);
    assert.equal(analysis.output.recommendedTask, "broker-opt-out");
    assert.match(analysis.model, /glm|venice/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.VENICE_BASE_URL;
    else process.env.VENICE_BASE_URL = originalBase;
  }
});

test("runVeniceAnalysis fails when Venice is not configured", async () => {
  const priorKey = process.env.VENICE_API_KEY;
  delete process.env.VENICE_API_KEY;
  try {
  await assert.rejects(
    () =>
      runVeniceAnalysis({
        caseId: "case_test",
        kind: "classify-case"
      }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.message, "venice-not-configured");
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
  } finally {
    if (priorKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = priorKey;
  }
});