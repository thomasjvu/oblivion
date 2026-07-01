import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrokerProfileUrlCandidates,
  parseRegionLabel
} from "../../src/domain/brokerProfileUrls.js";

test("parseRegionLabel extracts city and state abbreviation", () => {
  const parsed = parseRegionLabel("Boston, MA");
  assert.equal(parsed?.city, "Boston");
  assert.equal(parsed?.stateAbbr, "MA");
});

test("buildBrokerProfileUrlCandidates generates fastpeoplesearch profile paths", () => {
  const candidates = buildBrokerProfileUrlCandidates("Thomas J. Vu", "Boston, MA", {
    limit: 20,
    brokerLimit: 5
  });
  assert.ok(candidates.some((item) => item.brokerId === "fastpeoplesearch"));
  assert.ok(
    candidates.some((item) =>
      /fastpeoplesearch\.com\/name\/thomas-j-vu_ma\/boston/i.test(item.sourceUrl)
    )
  );
});