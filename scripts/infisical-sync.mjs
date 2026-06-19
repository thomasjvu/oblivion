#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureParentDir,
  filterEntriesByKeys,
  formatManagedEnvFile,
  formatDotenvEntries,
  parseDotenv,
} from "./lib/dotenv-utils.mjs";
import { loadInfisicalAuthEnv } from "./lib/infisical-env.mjs";
import {
  deleteInfisicalSecret,
  formatDotenv,
  listInfisicalSecrets,
  resolveInfisicalConfig,
  upsertInfisicalSecret,
} from "./lib/infisical-client.mjs";
import { INFISICAL_CONFIG, syncKeysForEnv } from "./lib/secrets-config.mjs";

loadInfisicalAuthEnv();

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    options[key] = value;
    i += 1;
  }

  if (!command || !["pull", "push", "backup", "prune"].includes(command)) {
    throw new Error(
      "Usage: node scripts/infisical-sync.mjs <pull|push|backup|prune> --env <dev|prod> [--input <file>] [--output <file>]",
    );
  }

  if (!options.env) {
    throw new Error("--env is required");
  }

  if (!INFISICAL_CONFIG.environments[options.env]) {
    throw new Error(`Unknown env: ${options.env}. Expected dev or prod.`);
  }

  return { command, options };
}

function getDefaultPath(envName, command) {
  const envConfig = INFISICAL_CONFIG.environments[envName];
  if (command === "push") {
    return envConfig.workingFile;
  }

  if (command === "backup") {
    return envConfig.infisicalBackupFile;
  }

  return envConfig.workingFile;
}

function filterSecrets(secrets, envName) {
  const allowed = new Set(syncKeysForEnv(envName));
  return secrets.filter((secret) => allowed.has(secret.secretKey));
}

async function readInputEntries(inputPath, envName) {
  const text = await fs.readFile(inputPath, "utf8");
  const entries = parseDotenv(text);
  return filterEntriesByKeys(entries, syncKeysForEnv(envName));
}

async function pullSecrets({ config, envName, outputPath }) {
  const secrets = filterSecrets(
    await listInfisicalSecrets({
      domain: config.domain,
      projectId: config.projectId,
      envName,
      secretPath: INFISICAL_CONFIG.secretPath,
      secretType: config.secretType,
    }),
    envName,
  );
  await ensureParentDir(outputPath);
  const entries = secrets.map((secret) => [secret.secretKey, secret.secretValue ?? ""]);
  await fs.writeFile(outputPath, formatManagedEnvFile(envName, entries), "utf8");
  console.log(`Wrote ${entries.length} managed secrets to ${outputPath}`);
}

async function pushSecrets({ config, envName, inputPath }) {
  const entries = await readInputEntries(inputPath, envName);
  const existingSecrets = filterSecrets(
    await listInfisicalSecrets({
      domain: config.domain,
      projectId: config.projectId,
      envName,
      secretPath: INFISICAL_CONFIG.secretPath,
      secretType: config.secretType,
    }),
    envName,
  );
  const existingKeys = new Set(existingSecrets.map((secret) => secret.secretKey));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const [key, value] of entries) {
    if (!value.trim()) {
      skipped += 1;
      continue;
    }
    const exists = existingKeys.has(key);
    await upsertInfisicalSecret({
      domain: config.domain,
      projectId: config.projectId,
      envName,
      secretPath: INFISICAL_CONFIG.secretPath,
      secretType: config.secretType,
      key,
      value,
      exists,
    });
    if (exists) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  console.log(
    `Synced ${entries.length} allowlisted keys to Infisical (${envName}): ${created} created, ${updated} updated, ${skipped} skipped (empty)`,
  );
}

async function backupSecrets({ config, envName, outputPath }) {
  const secrets = filterSecrets(
    await listInfisicalSecrets({
      domain: config.domain,
      projectId: config.projectId,
      envName,
      secretPath: INFISICAL_CONFIG.secretPath,
      secretType: config.secretType,
    }),
    envName,
  );
  await ensureParentDir(outputPath);
  await fs.writeFile(outputPath, formatDotenv(secrets), "utf8");
  console.log(`Wrote ${secrets.length} secrets to ${outputPath}`);
}

async function pruneSecrets({ config, envName }) {
  const allowed = new Set(syncKeysForEnv(envName));
  const secrets = await listInfisicalSecrets({
    domain: config.domain,
    projectId: config.projectId,
    envName,
    secretPath: INFISICAL_CONFIG.secretPath,
    secretType: config.secretType,
  });

  let deleted = 0;
  for (const secret of secrets) {
    if (allowed.has(secret.secretKey)) {
      continue;
    }
    const removed = await deleteInfisicalSecret({
      domain: config.domain,
      projectId: config.projectId,
      envName,
      secretPath: INFISICAL_CONFIG.secretPath,
      secretType: config.secretType,
      key: secret.secretKey,
    });
    if (removed) {
      deleted += 1;
      console.log(`Deleted ${secret.secretKey}`);
    }
  }

  console.log(`Pruned ${deleted} non-allowlisted secrets from Infisical (${envName})`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const envName = options.env;
  const config = resolveInfisicalConfig({
    projectId: process.env.INFISICAL_PROJECT_ID || INFISICAL_CONFIG.projectId,
    organizationId: process.env.INFISICAL_ORGANIZATION_ID || INFISICAL_CONFIG.organizationId,
  });

  if (command === "push") {
    const inputPath = path.resolve(options.input || getDefaultPath(envName, command));
    await pushSecrets({ config, envName, inputPath });
    return;
  }

  if (command === "prune") {
    await pruneSecrets({ config, envName });
    return;
  }

  const outputPath = path.resolve(options.output || getDefaultPath(envName, command));
  if (command === "backup") {
    await backupSecrets({ config, envName, outputPath });
    return;
  }

  await pullSecrets({ config, envName, outputPath });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});