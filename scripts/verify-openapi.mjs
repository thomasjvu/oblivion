#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`${label} is out of sync`);
    process.exit(1);
  }
}

const v1Spec = read("spec/openapi-v1.yaml");
const v1Docs = read("docs/public/openapi-v1.yaml");
assertEqual(v1Docs, v1Spec, "docs/public/openapi-v1.yaml");

const consumerSpec = read("docs/public/openapi-consumer.yaml");
for (const route of ["/api/cases:", "/api/cases/{caseId}/intake:"]) {
  if (!consumerSpec.includes(route)) {
    console.error(`openapi-consumer.yaml missing route ${route}`);
    process.exit(1);
  }
}
if (!consumerSpec.includes("riskLevel")) {
  console.error("openapi-consumer.yaml missing riskLevel on POST /api/cases");
  process.exit(1);
}
if (!consumerSpec.includes("401")) {
  console.error("openapi-consumer.yaml missing 401 response on GET /api/cases");
  process.exit(1);
}

console.log("OpenAPI specs verified");