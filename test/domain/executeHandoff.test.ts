import test from "node:test";
import assert from "node:assert/strict";
import { buildExecuteHandoff, extractEmailFromText } from "../../src/domain/executeHandoff.js";

test("buildExecuteHandoff maps confirmed exposure URL and intake email", () => {
  const handoff = buildExecuteHandoff({
    action: {
      exposureId: "exp_1",
      dataToDisclose: ["email", "legal-name"]
    },
    status: {
      confirmedFindings: [{ id: "exp_1", sourceUrl: "https://example.com/profile/jane" }]
    },
    intakeText: "Jane Doe — contact jane.doe@example.com for opt-out."
  });
  assert.equal(handoff.sourceUrl, "https://example.com/profile/jane");
  assert.equal(handoff.emailLabel, "jane.doe@example.com");
});

test("buildExecuteHandoff accepts a valid SHA-1 prefix for password range checks", () => {
  const handoff = buildExecuteHandoff({
    action: { actionType: "pwned-password-range-check" },
    hashPrefix: "ABC12"
  });
  assert.equal(handoff.hashPrefix, "abc12");
});

test("buildExecuteHandoff ignores invalid hash prefixes", () => {
  const handoff = buildExecuteHandoff({
    action: { actionType: "pwned-password-range-check" },
    hashPrefix: "not-a-prefix"
  });
  assert.equal(handoff.hashPrefix, undefined);
});

test("extractEmailFromText returns undefined when no email present", () => {
  assert.equal(extractEmailFromText("No contact info here."), undefined);
});