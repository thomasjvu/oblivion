#!/usr/bin/env node
/**
 * Validates curated broker seeds and reports catalog coverage.
 * Run: npx tsx scripts/import-broker-seeds.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extraPath = join(root, "config/broker-seeds-extra.json");
const catalogUrl = pathToFileURL(join(root, "src/domain/brokerCatalog.ts")).href;

const { validateBrokerCatalog, BROKER_CATALOG, buildBrokerSweepQueries } = await import(catalogUrl);

function loadExtraSeeds() {
  try {
    const raw = readFileSync(extraPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const extra = loadExtraSeeds();
const builtInIds = new Set(BROKER_CATALOG.map((entry) => entry.brokerId));
const duplicates = extra.filter((seed) => builtInIds.has(seed.brokerId));
const invalid = extra.filter((seed) => !seed.officialOptOutUrl?.startsWith("https://"));

const errors = validateBrokerCatalog();
const sweep = buildBrokerSweepQueries({ personLabel: "Jane Example" }, { preview: true });

console.log(`Built-in brokers: ${BROKER_CATALOG.length}`);
console.log(`Extra seed file: ${extra.length} (${extraPath})`);
console.log(`Preview sweep queries: ${sweep.length} hosts (${sweep.map((item) => item.host).join(", ")})`);

if (duplicates.length) {
  console.warn("Duplicate broker IDs in extra file:", duplicates.map((item) => item.brokerId).join(", "));
}
if (invalid.length) {
  console.error("Invalid opt-out URLs:", invalid.map((item) => item.brokerId).join(", "));
  process.exitCode = 1;
}
if (errors.length) {
  console.error("Catalog validation errors:", errors);
  process.exitCode = 1;
} else {
  console.log("Catalog validation: ok");
}