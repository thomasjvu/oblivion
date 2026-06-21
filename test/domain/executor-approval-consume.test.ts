import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExecutionStatusAfterExecute,
  shouldConsumeApprovalAfterExecute
} from "../../src/domain/executor.js";
import type { ConnectorResult } from "../../src/domain/types.js";

function handoffResult(caseId: string): ConnectorResult {
  return {
    id: "connector_handoff",
    caseId,
    connectorId: "hibp-password-range",
    status: "ready",
    sourceUrl: "https://haveibeenpwned.com",
    confidence: "high",
    requiresUserHandoff: true,
    summary: "Awaiting hash prefix",
    createdAt: new Date().toISOString()
  };
}

test("resolveExecutionStatusAfterExecute keeps action ready for handoff results", () => {
  assert.equal(
    resolveExecutionStatusAfterExecute({
      mode: "live",
      connectorResult: handoffResult("case_handoff")
    }),
    "ready"
  );
  assert.equal(
    shouldConsumeApprovalAfterExecute({
      mode: "live",
      executionRecord: "awaiting handoff",
      connectorResult: handoffResult("case_handoff")
    }),
    false
  );
  assert.equal(
    shouldConsumeApprovalAfterExecute({
      mode: "live",
      executionRecord: "live executor blocked: source verification missing"
    }),
    false
  );
});