#!/usr/bin/env node
/**
 * Oblivion Development Party Quest smoke test.
 *
 * Env:
 *   PARTY_QUEST_URL — default https://party-convex-site.phantasy.bot
 *   PARTY_QUEST_API_KEY — agent API key
 *   AGENT — oblivion-code | oblivion-debug | oblivion-marketing | oblivion-research
 *   CAMPAIGN_SLUG — default oblivion-development
 *   OBLIVION_REPO — path to repo (default ~/oblivion-ops/oblivion)
 *   CREDENTIALS_ENV — optional .env with PARTY_QUEST_API_KEY
 *
 * Flags: --claim-only, --skip-exec, --accept-any
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2026-02-01';
const WEBHOOK_PATHS = {
  heartbeat: '/webhook/heartbeat',
  runTrace: '/webhook/run-trace',
  runResult: '/webhook/run-result',
};

const AGENT_PROFILES = {
  'oblivion-code': {
    frameworkType: 'opencode',
    defaultQuest: 'Daily verify on main',
    workflowPath: 'npm run typecheck',
  },
  'oblivion-debug': {
    frameworkType: 'openclaw',
    defaultQuest: 'Forgejo CI failure response',
    workflowPath: null,
  },
  'oblivion-marketing': {
    frameworkType: 'phantasy',
    defaultQuest: 'Weekly docs verify',
    workflowPath: 'npm run build --prefix docs',
  },
  'oblivion-research': {
    frameworkType: 'hermes',
    defaultQuest: 'Broker catalog policy review',
    workflowPath: 'npm test -- test/orchestration/broker.test.ts',
  },
};

function parseEnvFile(path) {
  const values = {};
  if (!path) return values;
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
    // optional
  }
  return values;
}

function loadCredentialsFromAgentsJson(agentId, agentsJsonPath) {
  try {
    const store = JSON.parse(readFileSync(agentsJsonPath, 'utf8'));
    const entry = store.agents?.[agentId];
    if (entry?.apiKey && entry?.partyQuestUrl) {
      return { apiKey: entry.apiKey, partyQuestUrl: entry.partyQuestUrl };
    }
  } catch {
    // fall through
  }
  return null;
}

function joinUrl(base, pathname) {
  return `${base.replace(/\/+$/, '')}${pathname}`;
}

async function postJson(url, body, apiKey) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload?.error
        ? payload.error
        : String(payload || response.statusText);
    throw new Error(`Request failed (${response.status}) ${url}: ${message}`);
  }
  return payload;
}

function runCommand(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const claimOnly = argv.includes('--claim-only');
  const skipExec = argv.includes('--skip-exec') || claimOnly;
  const acceptAny =
    argv.includes('--accept-any') ||
    process.env.ACCEPT_ANY_QUEST === '1' ||
    process.env.ACCEPT_ANY_QUEST === 'true';

  const agentId = process.env.AGENT?.trim() || 'oblivion-code';
  const profile = AGENT_PROFILES[agentId];
  if (!profile) {
    throw new Error(`Unknown AGENT ${agentId}`);
  }

  const credentialsEnv = parseEnvFile(process.env.CREDENTIALS_ENV?.trim());
  const agentsJson =
    process.env.AGENTS_JSON?.trim() ||
    join(homedir(), 'oblivion-ops/phantasy-agent/.phantasy/party-quest/agents.json');
  const fromStore = loadCredentialsFromAgentsJson(agentId, agentsJson);

  const partyQuestUrl = (
    process.env.PARTY_QUEST_URL ||
    credentialsEnv.PARTY_QUEST_URL ||
    fromStore?.partyQuestUrl ||
    'https://party-convex-site.phantasy.bot'
  ).replace(/\/+$/, '');
  const apiKey =
    process.env.PARTY_QUEST_API_KEY ||
    credentialsEnv.PARTY_QUEST_API_KEY ||
    fromStore?.apiKey;
  if (!apiKey) {
    throw new Error('PARTY_QUEST_API_KEY required (env, CREDENTIALS_ENV, or agents.json)');
  }

  const questTitle = process.env.QUEST_TITLE?.trim() || profile.defaultQuest;
  const campaignSlug = process.env.CAMPAIGN_SLUG?.trim() || 'oblivion-development';
  const repoPath = resolve(
    process.env.OBLIVION_REPO?.trim() || join(homedir(), 'oblivion-ops/oblivion'),
  );

  const heartbeat = await postJson(
    joinUrl(partyQuestUrl, WEBHOOK_PATHS.heartbeat),
    {
      specVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      status: 'idle',
      frameworkType: profile.frameworkType,
      campaignSlug,
      maxAssignments: 1,
    },
    apiKey,
  );

  const assignment = heartbeat.assignment;
  if (!assignment?.runId || !assignment?.quest) {
    throw new Error(`No assignment claimed. Heartbeat: ${JSON.stringify(heartbeat, null, 2)}`);
  }

  const claimedTitle = assignment.quest.title;
  if (!acceptAny && claimedTitle !== questTitle) {
    throw new Error(
      `Claimed "${claimedTitle}" but expected "${questTitle}". Re-run with --accept-any.`,
    );
  }

  const evidence = {
    schemaVersion: 'oblivion.party-quest.development-smoke.v1',
    generatedAt: new Date().toISOString(),
    agentId,
    frameworkType: profile.frameworkType,
    questTitle: acceptAny ? claimedTitle : questTitle,
    runId: assignment.runId,
    questId: assignment.quest.questId,
    claimed: true,
    executed: false,
    ok: false,
  };

  if (skipExec) {
    evidence.ok = true;
    writeEvidence(evidence);
    return;
  }

  const workflowPath =
    assignment.quest.execution?.workflowPath ||
    (claimedTitle === profile.defaultQuest ? profile.workflowPath : null);

  if (!workflowPath) {
    await reportSuccess(partyQuestUrl, apiKey, assignment, {
      summary: `Claimed ${claimedTitle} (no workflow command)`,
      message: 'Quest claimed without local execution',
    });
    evidence.ok = true;
    writeEvidence(evidence);
    return;
  }

  await postJson(
    joinUrl(partyQuestUrl, WEBHOOK_PATHS.runTrace),
    {
      specVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: assignment.runId,
      questId: assignment.quest.questId,
      status: 'running',
      events: [
        {
          eventType: 'oblivion.development.exec',
          status: 'info',
          message: `Running ${workflowPath}`,
          timestamp: Date.now(),
        },
      ],
    },
    apiKey,
  );

  const commandResult = runCommand(workflowPath, repoPath);
  evidence.executed = true;
  evidence.command = workflowPath;
  evidence.commandOk = commandResult.ok;

  const summary = commandResult.ok
    ? `${workflowPath} succeeded`
    : `${workflowPath} failed (exit ${commandResult.status})`;

  await postJson(
    joinUrl(partyQuestUrl, WEBHOOK_PATHS.runResult),
    {
      specVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: assignment.runId,
      questId: assignment.quest.questId,
      status: commandResult.ok ? 'completed' : 'failed',
      summary,
      error: commandResult.ok
        ? undefined
        : (commandResult.stderr || commandResult.stdout).slice(0, 4000),
    },
    apiKey,
  );

  evidence.ok = commandResult.ok;
  writeEvidence(evidence);
  if (!commandResult.ok) {
    process.exit(1);
  }
}

async function reportSuccess(partyQuestUrl, apiKey, assignment, { summary, message }) {
  await postJson(
    joinUrl(partyQuestUrl, WEBHOOK_PATHS.runTrace),
    {
      specVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: assignment.runId,
      questId: assignment.quest.questId,
      status: 'running',
      events: [
        {
          eventType: 'oblivion.development.claim',
          status: 'info',
          message,
          timestamp: Date.now(),
        },
      ],
    },
    apiKey,
  );
  await postJson(
    joinUrl(partyQuestUrl, WEBHOOK_PATHS.runResult),
    {
      specVersion: PROTOCOL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: assignment.runId,
      questId: assignment.quest.questId,
      status: 'completed',
      summary,
    },
    apiKey,
  );
}

function writeEvidence(evidence) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = join(scriptDir, '..', 'evidence', 'party-quest');
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const appendPath =
    process.env.SMOKE_EVIDENCE_JSONL?.trim() ||
    join(outDir, `oblivion-development-smoke-${day}.jsonl`);
  appendFileSync(appendPath, `${JSON.stringify(evidence)}\n`);
  writeFileSync(join(outDir, `oblivion-development-smoke-${day}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});