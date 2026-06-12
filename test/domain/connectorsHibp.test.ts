import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHibpPasswordRangeConnectorResult,
  hibpEmailResultStatus
} from "../../src/domain/connectors/hibp.js";

test("hibpEmailResultStatus maps 404 to recorded", () => {
  assert.equal(hibpEmailResultStatus({ status: 404, ok: false } as Response), "recorded");
  assert.equal(hibpEmailResultStatus({ status: 200, ok: true } as Response), "ready");
});

test("buildHibpPasswordRangeConnectorResult uses prefix-only summary", () => {
  const result = buildHibpPasswordRangeConnectorResult("case_1", "ABCDE", {
    suffixCount: 3,
    status: "ready",
    rangeUrl: "https://api.pwnedpasswords.com/range/ABCDE"
  });
  assert.equal(result.connectorId, "hibp-password-range");
  assert.match(result.summary, /SHA-1 prefix/i);
  assert.equal(result.caseId, "case_1");
});