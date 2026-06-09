<div class="legal-page-header">

# Privacy Policy

<p class="legal-last-updated"><strong>Last updated:</strong> June 9, 2026</p>

</div>

Oblivion is built so you can clean up your online footprint without handing your identity to us. This policy explains what we do — and deliberately do not do — with information when you use the Oblivion web app and related open-source materials.

## Beta software

Oblivion is **beta / experimental** software. We make no warranty that data handling, removal outcomes, or security controls will meet your expectations. Use at your own risk.

## Our core rule

**We do not collect, sell, or profile your personal data for advertising.** Sensitive identifiers stay in your browser vault. The server stores only encrypted intake blobs and redacted case metadata needed to run supervised cleanup workflows.

## What stays on your device

- Raw identifiers you enter (names, emails, URLs, notes) are encrypted in the browser before intake is sent.
- Vault keys live in browser memory during a session; they are not written to our servers in plaintext.
- **Case access tokens** returned when you create a case are stored in browser `localStorage` (`oblivion.caseTokens`) so the app can authenticate API requests. Treat your browser like a password manager — anyone with access to this device may access active cases.
- **Device-local state** may also include: active case id, redacted case summaries, pasted discovery URL lists, UI preferences (sidebar, privacy filter, payment mode), and agent skill install metadata. Discovery URL lists may contain sensitive links you pasted for review.
- When you delete a case in the app, server-side case data is purged. Local browser storage for that case (tokens, summaries, discovery lists) should be cleared by the client; you can also clear site data in your browser settings.

## What the server may store

When you create a case, the server keeps:

- **Encrypted intake** (AES-256-GCM ciphertext your browser produced — we cannot read it without your key)
- **Redacted metadata** (jurisdiction, risk level, authority basis, redacted scope labels — no raw PII)
- **Access token hash** (one-way hash of your case access token — not the token itself)
- **Workflow records** (approvals, timeline events, connector results, and execution logs — redacted)
- **Wallet address** (if you connect a wallet for credits or Venice AI metering — used for a server-side credit ledger, not for marketing profiles)
- **Retention** — cases default to a 90-day retention window unless you delete sooner

Partner API integrations (B2B) use separate API-key auth; partner cases do not use consumer case access tokens on `/api/*`.

When you delete a case, associated server-side records (intake, approvals, timeline, and related workflow data) are removed.

## What we do not do

- No advertising or behavioral tracking
- No analytics pixels or third-party marketing SDKs in the app
- No account signup database of personal profiles
- No sale or rental of user information
- No training AI models on your plaintext identifiers

## Third-party services

If you choose to connect a wallet, use MetaMask, or enable optional integrations (for example Venice AI, x402 payments, 1Shot relayer demos, or Phala attestation in production), those providers operate under their own policies. Oblivion only sends **redacted** inputs across approval boundaries unless you explicitly approve a sensitive disclosure action.

Hosted deployments may use Cloudflare (UI/static assets) and Phala (TEE API runtime in production). Self-hosted copies follow your infrastructure policies.

## Logs

Server logs use redaction helpers so plaintext identifiers, secrets, and encrypted payload bodies should not appear in operational logs. Do not paste secrets into free-text fields that bypass the vault.

## Children

Oblivion is not directed at children under 13. We do not knowingly collect personal information from children.

## Changes

We may update this policy as the product evolves. Material changes will be reflected in this document with an updated date.

## Contact

Questions about privacy: open an issue at [github.com/thomasjvu/oblivion](https://github.com/thomasjvu/oblivion) or contact the maintainer listed in the repository.