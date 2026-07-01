#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogUrl = pathToFileURL(join(root, "src/domain/brokerCatalog.ts")).href;
const {
  BROKER_CATALOG,
  BROKER_SWEEP_PRIORITY,
  listBrokerCatalogSummary,
  buildBrokerSweepQueries
} = await import(catalogUrl);

const summary = listBrokerCatalogSummary();
const previewSweep = buildBrokerSweepQueries({ personLabel: "Example Person", regionLabel: "Boston, MA" }, { preview: true });
const previewHosts = [...new Set(previewSweep.map((item) => item.brokerId))];

const tableRows = summary
  .map((entry) => {
    const inPreview = previewHosts.includes(entry.brokerId) ? "yes" : "";
    return `| ${entry.brokerLabel} | ${entry.primaryHost} | ${entry.tier} | ${entry.teeAutomatable ? "yes" : "no"} | ${entry.sweepPriority ? "yes" : ""} | ${inPreview} | [opt-out](${entry.officialOptOutUrl}) |`;
  })
  .join("\n");

const markdown = `---
title: Broker catalog
description: People-search and background-check brokers Oblivion knows about — opt-out paths, sweep priority, and preview coverage.
---

# Broker catalog

Oblivion maintains a curated catalog of **${BROKER_CATALOG.length}** people-search and background-check sites. This page lists every broker we can recognize, link opt-out flows for, and include in discovery sweeps.

**API:** \`GET /api/brokers\` returns the same catalog as JSON.

[User guide](/docs/user-guide/overview) · [Templates](/docs/user-guide/templates) · [Consumer API](/docs/developers/consumer-api)

---

## How discovery uses this catalog

| Stage | What runs | Scoring |
|-------|-----------|---------|
| **Landing preview** | Site-scoped search across up to ${previewHosts.length} brokers per run (round-robin query budget) | Heuristic only; **likely** matches shown |
| **Full cleanup** | Broader sweep + profile URL patterns + pasted URLs + Venice when configured | Venice + heuristics; you confirm each match |

Preview does **not** query every catalog broker every time — search API query budgets limit how many \`site:host\` searches run per preview. Priority brokers (see table) are scheduled first.

**Tip:** If you already have a profile URL (e.g. FastBackgroundCheck \`/people/name/id/…\`), paste it on the landing form — Oblivion includes pasted URLs in full discovery even when preview search misses them.

---

## Catalog (${summary.length} brokers)

| Broker | Host | Tier | Automatable | Sweep priority | Preview sweep | Opt-out |
|--------|------|------|-------------|----------------|---------------|---------|
${tableRows}

---

## Priority sweep order

These brokers are queried first when building site-scoped searches:

${BROKER_SWEEP_PRIORITY.map((id) => `- \`${id}\``).join("\n")}

---

*Broker table is generated from the server catalog when maintainers sync documentation.*
`;

const mdPath = join(root, "docs/src/docs/content/user-guide/broker-catalog.md");
const jsonPath = join(root, "docs/public/broker-catalog.json");

writeFileSync(mdPath, markdown, "utf8");
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: summary.length,
      priority: BROKER_SWEEP_PRIORITY,
      previewSweepBrokerIds: previewHosts,
      brokers: summary
    },
    null,
    2
  ),
  "utf8"
);

console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${jsonPath} (${summary.length} brokers, ${previewHosts.length} in preview sweep sample)`);