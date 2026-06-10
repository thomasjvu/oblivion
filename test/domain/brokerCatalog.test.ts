import test from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_CATALOG,
  brokerForUrl,
  brokerCatalogEntryById,
  buildBrokerSweepQueries,
  previewBrokerSweepLimit,
  tier1BrokersForJurisdiction,
  validateBrokerCatalog
} from "../../src/domain/brokerCatalog.js";

test("broker catalog has 50+ tier-1 entries with valid opt-out URLs", () => {
  const errors = validateBrokerCatalog();
  assert.deepEqual(errors, []);
  assert.ok(BROKER_CATALOG.length >= 50);
  assert.ok(tier1BrokersForJurisdiction("US").length >= 40);
});

test("brokerForUrl resolves catalog hosts", () => {
  const spokeo = brokerForUrl("https://www.spokeo.com/John-Smith/New-York/");
  assert.equal(spokeo?.brokerId, "spokeo");
  assert.equal(spokeo?.teeAutomatable, true);
  const mylife = brokerForUrl("https://www.mylife.com/some-profile");
  assert.equal(mylife?.brokerId, "mylife");
  assert.equal(mylife?.teeAutomatable, false);
});

test("buildBrokerSweepQueries returns site-scoped queries from redacted labels", () => {
  const queries = buildBrokerSweepQueries({ personLabel: "John Smith", aliases: ["J. Smith"] });
  assert.ok(queries.length > 0);
  assert.match(queries[0].query, /site:spokeo\.com|"John Smith"/);
  assert.equal(brokerCatalogEntryById(queries[0].brokerId)?.primaryHost, queries[0].host);
});

test("preview broker sweep uses priority hosts and preview limit", () => {
  const queries = buildBrokerSweepQueries({ personLabel: "John Smith" }, { preview: true });
  assert.equal(queries.length, previewBrokerSweepLimit());
  assert.equal(queries[0].brokerId, "spokeo");
});

test("broker sweep queries include optional region label", () => {
  const queries = buildBrokerSweepQueries(
    { personLabel: "John Smith", regionLabel: "New York, NY" },
    { preview: true, limit: 1 }
  );
  assert.match(queries[0].query, /"John Smith" "New York, NY" site:/);
});