#!/usr/bin/env node
/**
 * Build .phantasy/party-quest/agents.json from runtime seed evidence.
 *
 * Usage:
 *   node scripts/write-party-quest-agents-json.mjs \
 *     --seed ~/oblivion-ops/runtime-agent-seed.json \
 *     --out ~/alkahest-ops/phantasy-agent/.phantasy/party-quest/agents.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const seedPath = readArg('--seed');
const outPath = readArg('--out');

const FRAMEWORK_TO_AGENT = {
  'oblivion-phantasy-agent': 'oblivion-marketing',
  'oblivion-hermes-agent': 'oblivion-research',
  'oblivion-openclaw-agent': 'oblivion-debug',
  'oblivion-opencode-agent': 'oblivion-code',
};

function readArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`Missing required ${flag}`);
  }
  return args[index + 1];
}

const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const partyQuestUrl =
  seed.partyQuestUrl?.replace(/\/$/, '') || 'https://party-convex-site.phantasy.bot';

const store = { agents: {} };
for (const entry of seed.agents || []) {
  const agentId = FRAMEWORK_TO_AGENT[entry.agentFrameworkId];
  if (!agentId || !entry.apiKey) continue;
  store.agents[agentId] = {
    apiKey: entry.apiKey,
    partyQuestUrl,
    partyQuestAgentId: entry.agentId,
  };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(store, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, outPath, agents: Object.keys(store.agents) }, null, 2));