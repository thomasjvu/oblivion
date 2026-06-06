#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${OBLIVION_PHALA_NAME:-oblivion}"
PHALA="${PHALA_CMD:-phala}"
TRUST_CENTER="$ROOT/config/trust-center.json"
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"

if [[ ! -f "$TRUST_CENTER" ]]; then
  echo "Trust center config not found: $TRUST_CENTER" >&2
  exit 1
fi

echo "Fetching compose hash from Phala CVM: $NAME"
ATTESTATION_JSON="$("$PHALA" cvms attestation "$NAME" --json 2>/dev/null)"

node --input-type=module -e "
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const trustCenterPath = process.argv[1];
const sourceCommit = process.argv[2];
const attestation = JSON.parse(process.argv[3]);

const eventLog = attestation.tcb_info?.event_log ?? [];
const composeEvent = eventLog.find((entry) => entry.event === 'compose-hash');
let expectedComposeHash = composeEvent?.event_payload;

if (!expectedComposeHash && attestation.tcb_info?.app_compose) {
  expectedComposeHash = createHash('sha256')
    .update(attestation.tcb_info.app_compose)
    .digest('hex');
}

if (!expectedComposeHash) {
  console.error('Could not resolve compose hash from Phala attestation output.');
  process.exit(1);
}

const config = JSON.parse(await readFile(trustCenterPath, 'utf8'));
config.sourceCommit = sourceCommit;
config.expectedComposeHash = expectedComposeHash.toLowerCase();
await writeFile(trustCenterPath, JSON.stringify(config, null, 2) + '\\n', 'utf8');
console.log('Updated expectedComposeHash:', config.expectedComposeHash);
console.log('Updated sourceCommit:', config.sourceCommit);
" "$TRUST_CENTER" "$SOURCE_COMMIT" "$ATTESTATION_JSON"

echo "Trust center synced. Rebuild the production image so the CVM serves the updated config."