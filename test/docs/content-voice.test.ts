import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { documentationTree, homepageConfig } from "../../docs/shared/documentation-config.js";

type DocTreeItem = {
  type: "file" | "directory";
  path?: string;
  children?: DocTreeItem[];
};

function collectPublishedPaths(items: DocTreeItem[], paths: string[] = []): string[] {
  for (const item of items) {
    if (item.type === "file" && item.path) {
      paths.push(item.path);
      continue;
    }

    if (item.type === "directory" && item.children) {
      collectPublishedPaths(item.children, paths);
    }
  }

  return paths;
}

const contentRoot = join(process.cwd(), "docs/src/docs/content");

const forbiddenPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "TypeScript source references", pattern: /\.ts\b/ },
  { name: "src/ paths", pattern: /\bsrc\// },
  { name: "npm run commands", pattern: /npm run\b/ },
  { name: "OBLIVION_ env vars", pattern: /OBLIVION_/ },
  { name: "CLEANUP_PRESETS", pattern: /CLEANUP_PRESETS/ },
  { name: "evaluateProposedAction", pattern: /evaluateProposed/ },
  { name: "runCleanupAgentStep", pattern: /runCleanup/ },
  { name: "internal step IDs", pattern: /collect-minimum-identifiers/ },
  { name: "requiresManagedPlaintext", pattern: /requiresManagedPlaintext/ },
];

const publishedPaths = collectPublishedPaths(documentationTree as DocTreeItem[]);

test("published docs avoid internal implementation leakage", () => {
  assert.ok(publishedPaths.length >= 10, "expected at least 10 published doc paths");

  for (const docPath of publishedPaths) {
    const filePath = join(contentRoot, `${docPath}.md`);
    const content = readFileSync(filePath, "utf8");

    for (const { name, pattern } of forbiddenPatterns) {
      assert.doesNotMatch(
        content,
        pattern,
        `${docPath}.md should not contain ${name}`
      );
    }
  }
});

test("docs site skips marketing homepage and opens on first doc", () => {
  assert.equal(homepageConfig.enabled, false);
});