# Oblivion Hackathon Demo

## Pitch

Oblivion is a private online identity cleanup agent network. Traditional removal services ask users to hand over the identity they want protected. Oblivion keeps case contents encrypted, gates sensitive work on explicit approvals, and uses crypto-native permissions and payments to coordinate cleanup tasks.

## 3-Minute Flow

1. `0:00-0:30` Problem: identity cleanup usually requires trusting another company with addresses, emails, phone numbers, and ID documents. Oblivion starts from an encrypted case where the server stores ciphertext and redacted metadata.
2. `0:30-1:15` Agentic setup: open the app, create a case, then click `Run cleanup` in the Oblivion agent chat. The agent prepares EIP-7702 Smart Account records, ERC-7715 permission, x402 one-off payment, ERC-7710 weekly monitor permission, Venice analysis, A2A sub-agent delegation, and 1Shot relay status.
3. `1:15-1:45` Approval gate: show that the agent pauses at an approval card naming destination, data categories, purpose, disclosure risk, and expiration. Explain that real disclosure cannot proceed without this exact approval.
4. `1:45-2:05` User approval: click `Approve exact action` in the chat, then `Next` to record the approved action. The demo executor records the packet for user-held submission and does not contact an external broker.
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

## Live Integration Swap Points

- Replace `createVeniceAnalysis` with authenticated Venice API calls after redaction and policy checks.
- Replace `createRelayerEvents` with signed 1Shot relay requests and verified webhooks.
- Replace `createPaymentSession` with the chosen x402 server/client library while preserving ERC-7710 caps and expiry.
- Replace `/api/metamask/demo-session` with MetaMask Smart Accounts Kit calls while preserving the same permission records.

## Safety Rules For Demo Data

Use synthetic identity data only. Do not enter real addresses, full SSNs, unredacted IDs, passwords, breach dumps, or payment cards. The demo adapter redacts obvious emails and phone numbers, but the product rule remains stronger: raw identifiers should only live in the browser vault or an approved attested TEE task payload.
