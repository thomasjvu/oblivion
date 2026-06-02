# Oblivion

Oblivion is a private, supervised agent for online identity cleanup. It helps users organize exposure findings, removal requests, approvals, payments, agent coordination, and follow-ups without turning the product into another plaintext identity broker.

Stored case contents are encrypted in the browser before persistence. The server stores ciphertext plus minimal redacted metadata. Any sensitive search, broker request, email, or external disclosure must be converted into a specific approval first.

## Quick Start

```sh
npm install
npm run dev
```

Open `http://localhost:8080`.

Run tests:

```sh
npm test
```

Optional design-system validation:

```sh
npm run design:lint
```

## What Works Locally

- Encrypted case shell and browser-side vault behavior.
- Redacted case summaries and status views.
- Policy checks for prohibited data and approval-gated actions.
- Record-only cleanup execution for safe demos.
- Trust Center endpoint with local `not-configured` status.
- Deterministic hackathon adapters for MetaMask Smart Accounts, x402/ERC-7710, Venice AI, A2A delegation, and 1Shot relay status.

Local mode is for development and demos. It does not prove that sensitive managed execution is running inside a live TEE.

## Trust And Data Handling

Oblivion cannot decrypt stored case vault data on the server. Sensitive data is encrypted in the browser before storage. For approved actions that require plaintext, data should be decrypted only in the browser or inside an attested TEE task payload for that exact action.

This does not make identity cleanup anonymous. If a user approves a broker opt-out, search-result removal, breach check, or controller request, the approved destination may receive the approved identifiers and data categories.

## API Overview

- Cases: `POST /api/cases`, `GET /api/cases`, `GET /api/cases/:id`, `POST /api/cases/:id/intake`
- Actions and approvals: `POST /api/actions/propose`, `POST /api/approvals/:id/approve`, `POST /api/actions/:id/execute`
- Trust: `GET /api/trust/attestation`, `GET /api/trust/privacy`
- Agent flow: `GET /api/agent/next`, `POST /api/agent/run-next`, `POST /api/agent/premium-task`, `POST /api/agent/monitor`
- Hackathon adapters: `GET /api/x402/products`, `POST /api/metamask/demo-session`, `POST /api/x402/one-off`, `POST /api/x402/subscription`, `POST /api/1shot/relay-demo`, `POST /api/1shot/webhook`, `POST /api/ai/classify-case`, `POST /api/ai/draft-request`, `POST /api/ai/review-approval`, `POST /api/agents/delegate`, `POST /api/agents/message`, `GET /api/agents/timeline`, `GET /api/hackathon/status`
- Portability: `POST /api/export`, `POST /api/delete`

## Docker And Phala

This repository includes a production template for Phala Confidential VM deployment:

- `Dockerfile` builds the app on Node 22 and exposes port `8080`.
- `docker-compose.phala.yml` maps `8080:8080`, mounts the dstack socket, and uses Phala-compatible environment variables.
- `config/trust-center.json` is a local placeholder until live deployment values are known.

The template is not a live production deployment until all release-time values are replaced:

1. Build and publish an immutable image such as `ghcr.io/thomasjvu/oblivion@sha256:<digest>`.
2. Replace the placeholder image digest in `docker-compose.phala.yml`.
3. Set secrets through Phala encrypted secrets, not plaintext Compose values.
4. Deploy the CVM from the digest-pinned Compose file.
5. Retrieve the live Phala attestation report URL.
6. Update `config/trust-center.json` with `deploymentVersion`, `sourceCommit`, `expectedComposeHash`, `attestationReportUrl`, and image digests.
7. Confirm `GET /api/trust/attestation` returns `verifierResult: "pass"` before enabling sensitive managed execution.

Required production environment:

```sh
PORT=8080
TRUST_CENTER_PATH=/app/config/trust-center.json
PHALA_ATTESTATION_URL=https://<your-cvm-attestation-report-url>
PHALA_VERIFIER_ENDPOINT=https://cloud-api.phala.com/api/v1/attestations/verify
ATTESTATION_MAX_AGE_SECONDS=600
OBLIVION_EXECUTOR_MODE=record-only
OBLIVION_DISABLE_PLAINTEXT_LOGS=true
```

Optional integration environment:

```sh
VENICE_API_KEY=
VENICE_BASE_URL=
VENICE_MODEL=
ONESHOT_API_KEY=
ONESHOT_BASE_URL=
X402_RECEIVING_ADDRESS=
X402_NETWORK=base
X402_TOKEN=USDC
```

## Design

`DESIGN.md` is the visual source of truth. The current direction is a dark, flat, monospace command center with sparse proof surfaces and an agent-first workflow.

## Security Notes

Read `SECURITY.md` before adding real search, broker, email, payment, or model-provider integrations. New external adapters must preserve policy checks, redaction, approval gates, no plaintext logging, and TEE attestation requirements for sensitive managed execution.
