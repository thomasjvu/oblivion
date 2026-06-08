import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionStatusAfterExecute } from "../../src/domain/executor.js";

test("resolveExecutionStatusAfterExecute marks live connector success as executed", () => {
  assert.equal(
    resolveExecutionStatusAfterExecute({
      mode: "live",
      connectorResult: {
        id: "result_1",
        caseId: "case_1",
        connectorId: "hibp-email",
        status: "ready",
        sourceUrl: "https://haveibeenpwned.com/api/v3",
        confidence: "high",
        requiresUserHandoff: false,
        summary: "ok",
        createdAt: new Date().toISOString()
      }
    }),
    "executed"
  );
});

test("resolveExecutionStatusAfterExecute keeps record-only path as recorded", () => {
  assert.equal(resolveExecutionStatusAfterExecute({ mode: "record-only" }), "recorded");
});

test("resolveExecutionStatusAfterExecute marks connector failure as failed", () => {
  assert.equal(
    resolveExecutionStatusAfterExecute({
      mode: "live",
      connectorResult: {
        id: "result_1",
        caseId: "case_1",
        connectorId: "hibp-email",
        status: "failed",
        sourceUrl: "https://haveibeenpwned.com/api/v3",
        confidence: "low",
        requiresUserHandoff: false,
        summary: "failed",
        createdAt: new Date().toISOString()
      }
    }),
    "failed"
  );
});