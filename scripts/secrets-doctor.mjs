#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareDotenvMaps, readDotenvFile } from "./lib/dotenv-utils.mjs";
import { loadInfisicalAuthEnv } from "./lib/infisical-env.mjs";

loadInfisicalAuthEnv();
import {
  INFISICAL_AUTH_ENV,
  INFISICAL_CONFIG,
  PROD_LIVE_SECRETS,
  PROD_OPTIONAL_SECRETS,
  PROD_REQUIRED_SECRETS,
  syncKeysForEnv,
} from "./lib/secrets-config.mjs";

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isGitIgnored(filePath) {
  try {
    await execFileAsync("git", ["check-ignore", "-q", filePath], {
      cwd: process.cwd(),
    });
    return true;
  } catch (error) {
    if (typeof error.code === "number" && error.code === 1) {
      return false;
    }

    throw error;
  }
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function filterNonEmptyEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => hasValue(value)),
  );
}

function comparisonIsClean(comparison) {
  if (!comparison) {
    return false;
  }

  return (
    comparison.missing.length === 0 &&
    comparison.extra.length === 0 &&
    comparison.changed.length === 0
  );
}

async function inspectEnvironment(envConfig) {
  const result = {
    name: envConfig.name,
    workingFile: envConfig.workingFile,
    infisicalBackupFile: envConfig.infisicalBackupFile,
    files: {},
    ignore: {},
    comparisons: {},
    missingRequired: [],
    missingLive: [],
    missingOptional: [],
  };

  const paths = [envConfig.workingFile, envConfig.infisicalBackupFile];

  for (const filePath of paths) {
    result.files[filePath] = await fileExists(filePath);
    result.ignore[filePath] = await isGitIgnored(filePath);
  }

  if (result.files[envConfig.workingFile] && result.files[envConfig.infisicalBackupFile]) {
    const syncKeys = new Set(syncKeysForEnv(envConfig.name));
    const working = filterNonEmptyEntries(await readDotenvFile(envConfig.workingFile));
    const backup = filterNonEmptyEntries(await readDotenvFile(envConfig.infisicalBackupFile));
    const managedWorking = Object.fromEntries(
      Object.entries(working).filter(([key]) => syncKeys.has(key)),
    );
    const managedBackup = Object.fromEntries(
      Object.entries(backup).filter(([key]) => syncKeys.has(key)),
    );
    result.comparisons.infisicalBackup = compareDotenvMaps(managedWorking, managedBackup);
  }

  if (envConfig.name === "prod" && result.files[envConfig.workingFile]) {
    const working = await readDotenvFile(envConfig.workingFile);
    result.missingRequired = PROD_REQUIRED_SECRETS.filter((key) => !hasValue(working[key]));
    result.missingLive = PROD_LIVE_SECRETS.filter((key) => !hasValue(working[key]));
    result.missingOptional = PROD_OPTIONAL_SECRETS.filter((key) => !hasValue(working[key]));
  }

  return result;
}

function printEnvironmentReport(report) {
  console.log(`\n[${report.name}]`);
  console.log(
    `working: ${report.workingFile} ${report.files[report.workingFile] ? "present" : "missing"} ${report.ignore[report.workingFile] ? "(gitignored)" : "(NOT gitignored)"}`,
  );
  console.log(
    `Infisical snapshot: ${report.infisicalBackupFile} ${report.files[report.infisicalBackupFile] ? "present" : "missing"} ${report.ignore[report.infisicalBackupFile] ? "(gitignored)" : "(NOT gitignored)"}`,
  );

  if (report.comparisons.infisicalBackup) {
    console.log(
      `Infisical snapshot sync: ${comparisonIsClean(report.comparisons.infisicalBackup) ? "OK" : "DRIFT"}`,
    );
  }

  if (report.name === "prod") {
    console.log(
      `required prod keys: ${report.missingRequired.length === 0 ? "OK" : `missing ${report.missingRequired.join(", ")}`}`,
    );
    if (report.missingLive.length > 0) {
      console.log(`live prod keys missing (warn): ${report.missingLive.join(", ")}`);
    }
    if (report.missingOptional.length > 0) {
      console.log(`optional prod keys missing: ${report.missingOptional.join(", ")}`);
    }
  }
}

async function main() {
  const reports = await Promise.all(
    Object.values(INFISICAL_CONFIG.environments).map(inspectEnvironment),
  );

  const hasInfisicalAuth =
    Boolean(process.env.INFISICAL_ACCESS_TOKEN) ||
    Boolean(process.env.INFISICAL_TOKEN) ||
    (Boolean(process.env.INFISICAL_MACHINE_CLIENT_ID) &&
      Boolean(process.env.INFISICAL_MACHINE_CLIENT_SECRET)) ||
    (Boolean(process.env.INFISICAL_CLIENT_ID) &&
      Boolean(process.env.INFISICAL_CLIENT_SECRET));
  const hasCloudflareAccess =
    Boolean(process.env.CF_ACCESS_CLIENT_ID) && Boolean(process.env.CF_ACCESS_CLIENT_SECRET);

  console.log("Oblivion secrets doctor");
  console.log(`Infisical auth env loaded: ${hasInfisicalAuth ? "yes" : "no"}`);
  console.log(`Cloudflare Access env loaded: ${hasCloudflareAccess ? "yes" : "no"}`);

  for (const report of reports) {
    printEnvironmentReport(report);
  }

  const problems = [];
  const warnings = [];

  for (const report of reports) {
    for (const [filePath, isIgnored] of Object.entries(report.ignore)) {
      if (!isIgnored) {
        problems.push(`${filePath} is not gitignored`);
      }
    }

    if (!report.files[report.workingFile]) {
      if (report.name === "prod") {
        warnings.push(`${report.workingFile} is missing (run secrets:pull:prod after bootstrap)`);
      } else {
        problems.push(`${report.workingFile} is missing`);
      }
    }

    if (
      report.comparisons.infisicalBackup &&
      !comparisonIsClean(report.comparisons.infisicalBackup)
    ) {
      problems.push(`${report.name} Infisical snapshot is out of sync with working file`);
    }

    if (report.missingRequired.length > 0) {
      problems.push(`${report.name} missing required keys: ${report.missingRequired.join(", ")}`);
    }

    if (report.missingLive.length > 0) {
      warnings.push(
        `${report.name} missing live keys (add before mainnet settlement / HIBP): ${report.missingLive.join(", ")}`,
      );
    }
  }

  if (!hasInfisicalAuth) {
    const authNames = INFISICAL_AUTH_ENV.map((entry) => entry.name).join(", ");
    warnings.push(`Infisical auth env is not loaded in this shell (${authNames})`);
  } else if (!hasCloudflareAccess) {
    warnings.push(
      "Cloudflare Access service token not loaded; local scripts may rely on `cloudflared access login`",
    );
  }

  if (problems.length > 0) {
    console.error("\nProblems:");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log("\nStatus: OK");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});