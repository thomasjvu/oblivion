#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/src/icon-collections");

const PIXELARTICONS = [
  "alert", "archive", "arrow-right", "cast", "chart", "check", "chevron-down", "close",
  "copy", "delete", "download", "external-link", "eye-closed", "github", "link", "list",
  "lock", "pin", "play", "plus", "search", "sliders", "wallet"
];

const PIXEL = ["bars-solid", "plus-solid", "x"];

function subsetCollection(packageName, names) {
  const packageDir = join(root, "node_modules", packageName);
  const source = JSON.parse(readFileSync(join(packageDir, "icons.json"), "utf8"));
  const info = JSON.parse(readFileSync(join(packageDir, "info.json"), "utf8"));
  const icons = {};
  for (const name of names) {
    const icon = source.icons[name];
    if (!icon) throw new Error(`Missing icon ${packageName}/${name}`);
    icons[name] = icon;
  }
  const width = info.width ?? info.height ?? 24;
  const height = info.height ?? info.width ?? 24;
  return { prefix: source.prefix, width, height, icons };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "pixelarticons.json"),
  JSON.stringify(subsetCollection("@iconify-json/pixelarticons", PIXELARTICONS))
);
writeFileSync(
  join(outDir, "pixel.json"),
  JSON.stringify(subsetCollection("@iconify-json/pixel", PIXEL))
);