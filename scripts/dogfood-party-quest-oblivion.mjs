#!/usr/bin/env node
/**
 * Run Oblivion development smokes for all four agents.
 *
 * Flags: --dry-run, --pause-bridges, --reseed, --accept-any, --claim-only, --skip-exec
 */

import { spawnSync, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = ['oblivion-code', 'oblivion-debug', 'oblivion-marketing', 'oblivion-research'];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.env.OBLIVION_REPO || join(scriptDir, '..'));
const envDir = resolve(
  process.env.OBLIVION_AGENT_ENV_DIR || join(homedir(), 'oblivion-ops/workspaces/env'),
);
const smokeScript = join(repoRoot, 'scripts/smoke-party-quest-oblivion.mjs');
const day = new Date().toISOString().slice(0, 10);
const evidenceDir = join(repoRoot, 'evidence', 'party-quest');
const evidenceJsonl =
  process.env.SMOKE_EVIDENCE_JSONL?.trim() ||
  join(evidenceDir, `oblivion-development-smoke-${day}.jsonl`);

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const pauseBridges = argv.includes('--pause-bridges');
const reseedEach = argv.includes('--reseed');
const extraArgs = argv.filter(
  (arg) => !['--pause-bridges', '--reseed', '--dry-run', '--help', '-h'].includes(arg),
);
const partyQuestDir = process.env.PARTY_QUEST_DIR?.trim() || join(homedir(), 'party-quest');
const BRIDGE_PORTS = [2101, 2102, 2103];

function pauseBridgeProcesses() {
  if (!pauseBridges) return;
  for (const port of BRIDGE_PORTS) {
    try {
      execSync(`lsof -ti :${port} 2>/dev/null | xargs -r kill 2>/dev/null || true`, {
        shell: true,
        stdio: 'ignore',
      });
    } catch {
      // best effort
    }
  }
}

function reseedQuests() {
  if (!reseedEach) return;
  process.stdout.write('Reseeding oblivion-development quests...\n');
  const result = spawnSync(
    'bash',
    [
      '-lc',
      `cd "${partyQuestDir}" && set -a && source .env.self-hosted && set +a && npx convex run seed:seedOblivionDevelopment`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'reseed failed\n');
    throw new Error('Quest re-seed failed');
  }
}

function runAgent(agentId) {
  const credentialsEnv = join(envDir, `${agentId}.env`);
  process.stdout.write(`\n=== ${agentId} ===\n`);
  const result = spawnSync(process.execPath, [smokeScript, '--accept-any', ...extraArgs], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT: agentId,
      OBLIVION_REPO: repoRoot,
      CREDENTIALS_ENV: credentialsEnv,
      SMOKE_EVIDENCE_JSONL: evidenceJsonl,
      ACCEPT_ANY_QUEST: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

mkdirSync(evidenceDir, { recursive: true });

if (dryRun) {
  process.stdout.write(
    JSON.stringify({ dryRun: true, repoRoot, envDir, evidenceJsonl, agents: AGENTS }, null, 2) +
      '\n',
  );
  process.exit(0);
}

pauseBridgeProcesses();
if (reseedEach) reseedQuests();

let failures = 0;
for (const agent of AGENTS) {
  if (reseedEach) reseedQuests();
  if (runAgent(agent) !== 0) failures += 1;
}

process.stdout.write(`\nEvidence: ${evidenceJsonl}\n`);
process.exit(failures > 0 ? 1 : 0);