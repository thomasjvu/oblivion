import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDotenv } from "./dotenv-utils.mjs";

const ROOT = process.cwd();

export function loadInfisicalAuthEnv() {
  loadEnvFileIntoProcess(path.resolve(ROOT, ".env.infisical"));

  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return;
  }

  const candidates = [
    path.resolve(ROOT, "../repos/pokemon-llm/.env"),
    path.resolve(ROOT, "../@phantasy/rally_sh/apps/api/.env"),
  ];

  for (const candidate of candidates) {
    try {
      const entries = Object.fromEntries(parseDotenv(readFileSync(candidate, "utf8")));
      if (entries.CF_ACCESS_CLIENT_ID && entries.CF_ACCESS_CLIENT_SECRET) {
        process.env.CF_ACCESS_CLIENT_ID = entries.CF_ACCESS_CLIENT_ID;
        process.env.CF_ACCESS_CLIENT_SECRET = entries.CF_ACCESS_CLIENT_SECRET;
        return;
      }
    } catch {
      // try next candidate
    }
  }
}

function loadEnvFileIntoProcess(filePath) {
  try {
    const entries = parseDotenv(readFileSync(filePath, "utf8"));
    for (const [key, value] of entries) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // optional local auth file
  }
}