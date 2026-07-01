import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverySearchMode,
  regionLabelFromScope,
  resolveBrokerSweepScope,
  validateDiscoverySearchLabels
} from "../../src/domain/discoverySearchLabels.js";

test("validateDiscoverySearchLabels redacts ephemeral search labels", () => {
  const labels = validateDiscoverySearchLabels({
    personLabel: "Jane Doe",
    aliases: ["J. Doe"],
    regionLabel: "Boston, MA"
  });
  assert.equal(labels?.personLabel, "Jane Doe");
  assert.deepEqual(labels?.aliases, ["J. Doe"]);
  assert.equal(labels?.regionLabel, "Boston, MA");
});

test("regionLabelFromScope reads city from sensitiveConstraints", () => {
  const region = regionLabelFromScope({
    personLabel: "J.D.",
    aliases: [],
    approvedIdentifierLabels: ["city-state"],
    sensitiveConstraints: ["Boston, MA"]
  });
  assert.equal(region, "Boston, MA");
});

test("resolveBrokerSweepScope prefers ephemeral labels and falls back to stored region", () => {
  const sweep = resolveBrokerSweepScope(
    {
      personLabel: "J.D.",
      aliases: [],
      approvedIdentifierLabels: ["city-state"],
      sensitiveConstraints: ["Boston, MA"]
    },
    { personLabel: "Jane Doe", aliases: [], regionLabel: "Cambridge, MA" }
  );
  assert.equal(sweep?.personLabel, "Jane Doe");
  assert.equal(sweep?.regionLabel, "Cambridge, MA");
});

test("resolveBrokerSweepScope backfills region when only redacted scope is available", () => {
  const sweep = resolveBrokerSweepScope({
    personLabel: "J.D.",
    aliases: ["Jane Doe"],
    approvedIdentifierLabels: ["city-state"],
    sensitiveConstraints: ["Austin, TX"]
  });
  assert.equal(sweep?.personLabel, "J.D.");
  assert.equal(sweep?.regionLabel, "Austin, TX");
});

test("discoverySearchMode distinguishes ephemeral and redacted discovery", () => {
  assert.equal(
    discoverySearchMode({ personLabel: "J.D.", aliases: [], approvedIdentifierLabels: [], sensitiveConstraints: [] }),
    "redacted"
  );
  assert.equal(
    discoverySearchMode(
      { personLabel: "J.D.", aliases: [], approvedIdentifierLabels: [], sensitiveConstraints: [] },
      { personLabel: "Jane Doe" }
    ),
    "ephemeral"
  );
});