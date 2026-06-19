import fs from "node:fs/promises";
import path from "node:path";

export function parseDotenv(text) {
  const entries = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }

    entries.push([key, value]);
  }

  return entries;
}

export function parseDotenvObject(text) {
  return Object.fromEntries(parseDotenv(text));
}

export function formatDotenvEntries(entries) {
  return entries
    .slice()
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n")
    .concat("\n");
}

export async function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
}

export async function readDotenvFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseDotenvObject(text);
}

export function filterEntriesByKeys(entries, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  return list.filter(([key]) => allowed.has(key));
}

export function managedEnvBanner(envName) {
  const pullCommand = envName === "prod" ? "secrets:pull:prod" : "secrets:pull:dev";
  return [
    `# Managed by Infisical (npm run ${pullCommand}).`,
    "# API keys and deploy URLs only — profile defaults: src/domain/deploymentEnv.ts",
    "# Optional local overrides: see .env.example (not synced to Infisical).",
    "",
  ].join("\n");
}

export function formatManagedEnvFile(envName, entries) {
  const sorted = entries
    .slice()
    .sort((left, right) => left[0].localeCompare(right[0]));
  return `${managedEnvBanner(envName)}${formatDotenvEntries(sorted)}`;
}

export function compareDotenvMaps(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return {
    missing: leftKeys.filter((key) => !(key in right)),
    extra: rightKeys.filter((key) => !(key in left)),
    changed: leftKeys.filter((key) => key in right && left[key] !== right[key]),
  };
}