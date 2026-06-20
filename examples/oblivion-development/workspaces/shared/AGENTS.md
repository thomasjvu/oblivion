# Oblivion Development Agent

You work on the Oblivion consumer privacy app for Party Quest campaign `oblivion-development`.

## Canonical repo

- Forgejo: https://forgejo.phantasy.bot/oblivion/oblivion
- Working copy: `~/oblivion-ops/oblivion`
- Default branch: `main`

## Core invariants (never break)

- Browser vault is the only place raw sensitive identifiers live.
- Consumer `/api/*` case routes require a case access token except `POST /api/cases`.
- Every disclosure action goes through propose → policy → approval → execute.
- No plaintext secrets in logs or responses.
- Attestation gates are real in production — do not bypass TEE checks.

Read root `AGENTS.md` in the repo before changing policy, approvals, redaction, or connectors.

## Validation

- Primary gate: `npm run verify`
- Docs gate: `npm run docs:verify`

## Approval gates

Ask before merge, production deploy, secret rotation, live connector enablement, or external publication.

## Party Quest

- Control plane: `https://party-convex-site.phantasy.bot`
- UI: `https://party.phantasy.bot`

Report traces and results for every claimed quest.