# Oblivion Security Model

Oblivion is designed to minimize what users must trust, but it cannot make third-party identity cleanup anonymous. Data brokers, search engines, controllers, and breach-check services may receive identifiers when the user approves a specific action.

## Managed Oblivion

Managed Oblivion adds controls that a portable skill cannot guarantee on its own:

- Client-side encryption before case persistence.
- Server-side storage of ciphertext plus minimal redacted metadata.
- Policy enforcement before LLM/tool use.
- Phala Confidential VM deployment target.
- Public Trust Center metadata for attestation, compose hash, image digests, source commit, and deployment version.
- Live Phala attestation fetching through `PHALA_ATTESTATION_URL`.
- Intel TDX quote verification through Phala's verifier endpoint.
- Client-side blocking for sensitive actions unless Trust Center status is passing.
- Record-only default executor until external connectors are explicitly integrated behind approval gates.

## Installable Skill

The installable skill at `/Users/area/Desktop/custom-skills/clean-online-identity/SKILL.md` is a portable workflow for other agents. It defines safety rules, output contracts, approval standards, and data-minimization guidance. It does not by itself prove that the host agent, logs, plugins, or model provider are private.

## Never Store

- Passwords.
- Full SSNs.
- Full government ID numbers.
- Payment card data.
- Account recovery codes.
- Unredacted identity documents.
- Unredacted high-risk current address evidence unless specifically required and encrypted.

## Approval Boundary

Every sensitive action must bind:

- Destination.
- Action type.
- Identifier categories.
- Data categories disclosed.
- Purpose.
- Disclosure risk.
- Expiration.
- User confirmation.

Broad consent is not enough. The system converts broad intent into concrete approval records.

## Production Requirements

- Replace placeholder Trust Center values with live Phala attestation evidence.
- Set `PHALA_ATTESTATION_URL` to the live CVM attestation report endpoint.
- Confirm `GET /api/trust/attestation` returns `verifierResult: "pass"` before accepting sensitive tasks.
- Pin every production image by `@sha256:` digest.
- Keep secrets in Phala encrypted secrets, not Docker Compose plaintext.
- Disable plaintext logs and request tracing.
- Add external adapters only after tests prove blocked execution without matching approval.

## User-Facing Claim

Use precise wording:

> Oblivion cannot read your stored case vault. Sensitive data is encrypted in your browser before storage. For approved actions that require plaintext, data is decrypted only in your browser or inside an attested TEE task for that specific action.

Avoid absolute wording such as "we never touch data" because approved third-party submissions still disclose the user's approved identifiers to brokers, controllers, search engines, or breach-check services.
