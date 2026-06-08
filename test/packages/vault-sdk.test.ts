import assert from "node:assert/strict";
import test from "node:test";
import { redactedScopeFromIntake } from "../../packages/vault-sdk/helpers.js";

test("redactedScopeFromIntake builds redacted scope from intake fields", () => {
  const scope = redactedScopeFromIntake({
    legalName: "Jane Doe",
    email: "jane@example.com",
    cityState: "Austin, TX",
    aliases: ["J. Doe"],
    sensitiveConstraints: ["no workplace disclosure"]
  });

  assert.equal(scope.personLabel, "J.D.");
  assert.deepEqual(scope.aliases, ["J. Doe"]);
  assert.ok(scope.approvedIdentifierLabels.includes("legal-name"));
  assert.ok(scope.approvedIdentifierLabels.includes("email"));
  assert.ok(scope.approvedIdentifierLabels.includes("city-state"));
  assert.deepEqual(scope.sensitiveConstraints, ["no workplace disclosure"]);
});

test("redactedScopeFromIntake defaults person label and identifier labels", () => {
  const scope = redactedScopeFromIntake({});

  assert.equal(scope.personLabel, "User");
  assert.deepEqual(scope.approvedIdentifierLabels, ["email"]);
  assert.deepEqual(scope.aliases, []);
  assert.deepEqual(scope.sensitiveConstraints, []);
});