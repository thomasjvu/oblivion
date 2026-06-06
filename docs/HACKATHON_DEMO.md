# Oblivion Hackathon Demo

## Pitch

Oblivion is a private online identity cleanup agent network. Traditional removal services ask users to hand over the identity they want protected. Oblivion keeps case contents encrypted, gates sensitive work on explicit approvals, and uses crypto-native permissions and payments to coordinate cleanup tasks.

## 3-Minute Flow

1. `0:00-0:30` Problem: identity cleanup usually requires trusting another company with addresses, emails, phone numbers, and ID documents. Oblivion starts from an encrypted case where the server stores ciphertext and redacted metadata.
2. `0:30-1:15` Agentic setup: open the app, create a case, then click **Connect & enable Smart Account** on the dashboard strip (MetaMask popup). This records EIP-7702 + ERC-7715, then continue with **Do next step** / x402 / Venice / A2A / 1Shot in **Settings → Payments**.
3. `1:15-1:45` Approval gate: show that the agent pauses at an approval card naming destination, data categories, purpose, disclosure risk, and expiration. Explain that real disclosure cannot proceed without this exact approval.
4. `1:45-2:05` User approval: click `Approve exact action` in the chat, then `Next` to execute. With `OBLIVION_EXECUTOR_MODE=record-only` (default) the server records the packet; with `live` + TEE pass it runs official connector paths (HIBP range, Google plan, broker handoff).
5. `2:05-2:35` Proof tabs: inspect `Payments`, `Agent Network`, and `Relayer Status` to show x402/ERC-7710, Venice, A2A, and 1Shot artifacts.
6. `2:35-2:55` Trust posture: show the trust strip and Trust Center details. If the Phala CVM is not configured locally, call out that sensitive managed execution remains blocked.
7. `2:55-3:00` Checklist: return to `Overview` and show the hackathon checklist with every major track marked ready.

## Track Checklist

- Best Agent: supervised cleanup workflow, approval-gated actions, concrete drafts, follow-ups, and case status.
- MetaMask Smart Accounts: Smart Account session is first-class in the payment flow, with EIP-7702 and ERC-7715 records.
- x402 + ERC-7710: one-off and weekly subscription payment sessions are represented with x402 request payloads and ERC-7710 delegation scopes.
- Venice AI: Venice endpoints are core to classification, drafting, and approval review, with redaction before analysis.
- A2A redelegation: root agent redelegates limited roles to Scout, Draft, Verifier, and Payment agents.
- 1Shot: relayer panel records transaction status and webhook-compatible events.

## Environment Setup (live tracks)

Copy `.env.example` → `.env` and fill:

```sh
VENICE_API_KEY=...                    # required for live agent chat / classify / draft
X402_PAY_TO=0xYourWallet...           # seller wallet on Base Sepolia or mainnet
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_NETWORK=eip155:84532             # Base Sepolia CAIP-2 id
ONESHOT_BASE_URL=https://relayer.1shotapi.com/relayers
WALLET_LIVE_MODE=true                 # optional Sepolia smart-account upgrade
HIBP_API_KEY=...                      # optional; email check needs TEE pass
OBLIVION_EXECUTOR_MODE=live           # optional; still approval + policy gated
PHALA_ATTESTATION_URL=...             # required for managed-plaintext connectors
```

Readiness: `GET /api/integrations/status` · x402: `GET /api/x402/config`

## Live Integration Endpoints

- **Venice**: `/api/ai/*`, `/api/agent/chat` — redacted prompts; 503 without `VENICE_API_KEY`.
- **x402**: `POST /api/x402/one-off|subscription` prepares ERC-7710 scope; `POST /api/agent/premium-task|monitor` returns HTTP 402 + `PAYMENT-REQUIRED` when configured, settles via facilitator on `PAYMENT-SIGNATURE`.
- **1Shot**: `POST /api/1shot/relay` — JSON-RPC forward (`method` + `params`) or `taskId` poll; demo fallback when `ONESHOT_DEMO_FALLBACK=true`.
- **Connectors**: `POST /api/connectors/*` for direct calls; approved actions use `POST /api/actions/:id/execute` with optional `emailLabel` / `hashPrefix` handoff (never stored).
- **MetaMask**: `WALLET_LIVE_MODE=true` + **Upgrade via MetaMask (Sepolia)**; server records `/api/metamask/demo-session` with `mode: live`.

## Safety Rules For Demo Data

Use synthetic identity data only. Do not enter real addresses, full SSNs, unredacted IDs, passwords, breach dumps, or payment cards. The demo adapter redacts obvious emails and phone numbers, but the product rule remains stronger: raw identifiers should only live in the browser vault or an approved attested TEE task payload.
