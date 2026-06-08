<div class="legal-page-header">

# Privacy Policy

<p class="legal-last-updated"><strong>Last updated:</strong> June 5, 2026</p>

</div>

Oblivion is built so you can clean up your online footprint without handing your identity to us. This policy explains what we do — and deliberately do not do — with information when you use the Oblivion web app and related open-source materials.

## Our core rule

**We do not collect, sell, or profile your personal data.** Sensitive identifiers stay in your browser vault. The server stores only encrypted intake blobs and redacted case metadata needed to run supervised cleanup workflows.

## What stays on your device

- Raw identifiers you enter (names, emails, URLs, notes) are encrypted in the browser before intake is sent.
- Vault keys live in browser memory during a session; they are not written to our servers in plaintext.
- Optional browser storage keeps redacted case summaries and the active case id so you can resume work locally.

## What the server may store

When you create a case, the server keeps:

- **Encrypted intake** (AES-256-GCM ciphertext your browser produced — we cannot read it without your key)
- **Redacted metadata** (jurisdiction, risk level, authority basis, redacted scope labels — no raw PII)
- **Workflow records** (approvals, timeline events, connector results, and execution logs — redacted)

When you delete a case, server-side case data is purged.

## What we do not do

- No advertising or behavioral tracking
- No analytics pixels or third-party marketing SDKs in the app
- No account signup database of personal profiles
- No sale or rental of user information
- No training AI models on your plaintext identifiers

## Third-party services

If you choose to connect a wallet, use MetaMask, or enable optional integrations (for example Venice, x402, or relayer demos), those providers operate under their own policies. Oblivion only sends **redacted** inputs across approval boundaries unless you explicitly approve a sensitive disclosure action.

## Logs

Server logs use redaction helpers so plaintext identifiers, secrets, and encrypted payload bodies should not appear in operational logs. Do not paste secrets into free-text fields that bypass the vault.

## Children

Oblivion is not directed at children under 13. We do not knowingly collect personal information from children.

## Changes

We may update this policy as the product evolves. Material changes will be reflected in this document with an updated date.

## Contact

Questions about privacy: open an issue at [github.com/thomasjvu/oblivion](https://github.com/thomasjvu/oblivion) or contact the maintainer listed in the repository.