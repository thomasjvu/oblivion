# FAQ

Quick answers about Oblivion — the supervised cleanup agent, browser vault, approvals, credits, and how we differ from subscription removal services.

**New here?** [User guide overview](/docs/user-guide/overview) · [Pricing](/docs/pricing) · [Open app](https://oblivion.phantasy.bot)

---

## General

### What is Oblivion?

Oblivion is a **supervised cleanup agent** for people-search listings, breach awareness, and search suppression. It discovers exposures, drafts opt-out steps, and **pauses for your explicit approval** before anything is sent externally. It is a tool — not a law firm, investigator, or guaranteed removal service.

### Is Oblivion beta software?

Yes. Oblivion is **beta and experimental**. Features, APIs, connectors, and security controls may change without notice. Use at your own risk. See [Terms](/docs/legal/terms) for the full disclaimer.

### Is this legal or security advice?

No. Nothing in Oblivion or these docs is legal, regulatory, or professional security advice. You are responsible for reviewing each approval before it sends.

### How is my personal information stored?

Raw identifiers (names, emails, URLs, notes) are **encrypted in your browser vault** (AES-256-GCM). The server stores only `encryptedIntake` plus **redacted** case metadata needed to run workflows. We do not sell or profile your data for advertising. See [Privacy](/docs/legal/privacy).

### Does Oblivion guarantee removals?

No. Outcomes depend on third-party sites, brokers, and your specific listings. Oblivion records what was proposed, approved, and executed so you can audit the trail.

---

## Using the app

### How do I start a cleanup?

1. Open [Oblivion](https://oblivion.phantasy.bot)
2. Pick a **template** or describe what to clean up
3. Tap **Start cleanup** — your case opens in the workspace

Or type a one-line request in the landing composer. See [Overview](/docs/user-guide/overview).

### What are templates?

Templates are preset cleanup routes (people-search, breach check, search suppression, etc.). Each drives discovery steps, approvals, and recheck timing. See [Templates](/docs/user-guide/templates).

### What is a case access token?

When you create a case, the app stores a **case access token** in your browser. Consumer `/api/*` routes require this token — there is no account login. Keep the same browser/device or you will need a new case.

### Can anything send without my approval?

**No.** Every disclosure goes through propose → policy check → **your explicit confirmation** → execute. Wallet credits pay for AI and live relay capacity; they do not bypass approvals.

### What does “record-only” mean?

By default, connectors run in **record-only** mode: the agent logs what *would* be sent without making live external calls. Sensitive live connectors require attestation and policy gates. See [Trust & Security](/docs/developers/security).

---

## Credits and wallet

### Do I need a wallet to use Oblivion?

**No** for core cleanup — discovery, approvals, and practice-run execution work without credits.

Connect a wallet when you want **Venice AI** (chat, classify, draft), **live operator email relay**, or **x402 payment demos**.

### What do credits buy?

| Use | Default cost |
|-----|----------------|
| Venice agent chat | 1 credit per 100 tokens (minimum 1) |
| Live operator email relay | 25 credits per send |

**Starter pack:** $5 USDC → 500 credits · **Monitor:** $10 USDC/mo → 1,200 credits/month. Details in [Pricing](/docs/pricing).

### Can I switch between Starter and Monitor later?

Yes — **Settings → Payment rails** for top-ups or subscription.

---

## Compared to other services

### How is Oblivion different from Incogni, DeleteMe, or Optery?

Those services are typically **subscription broker-removal** products with large pre-negotiated broker lists and hands-off operation.

Oblivion is **supervised**: you approve each disclosure, identifiers stay in a **browser vault**, and you can run core workflows **without a subscription**. See the full [pricing comparison](/docs/pricing#how-oblivion-compares).

### When should I use a subscription removal service instead?

If you want fully managed removal, family plans, identity/credit monitoring bundles, or 24/7 phone support — a traditional subscription service may fit better. Oblivion fits when you want **control, transparency, and optional pay-as-you-go** capacity.

---

## Developers and partners

### Consumer API vs Partner API?

- **Consumer API** (`/api/*`) — browser app; case access tokens; for the hosted UI and self-hosted consumer deployments.
- **Partner API** (`/v1/*`) — API keys; embed in password managers, VPNs, security products; separate credit pool.

See [Consumer API](/docs/developers/consumer-api) and [Partner API](/docs/developers/partner-api).

### Can I self-host or embed Oblivion?

Yes. The core is open source. Partners embed via `/v1/*` without server-side vault decrypt. See [Partner onboarding](/docs/developers/partner-onboarding) and [SECURITY.md](https://github.com/thomasjvu/oblivion/blob/main/SECURITY.md).

### Is there an agent skill for Cursor / Claude / Codex?

Yes — install from the [landing page](https://oblivion.phantasy.bot#install-skill) or [SKILL.md on GitHub](https://github.com/thomasjvu/oblivion/blob/main/skills/clean-online-identity/SKILL.md). Same supervised rules as the managed app.

---

## Documentation site

### How do I search the docs?

Press **Cmd/Ctrl + K** to open the command palette, then type your query. Production builds also index full-text search via Pagefind.

### What keyboard shortcuts are available?

| Shortcut | Action |
|----------|--------|
| **Cmd/Ctrl + K** | Command palette |
| **Cmd/Ctrl + I** | Toggle theme |
| **Shift + ← / →** | Previous / next doc page |
| **Esc** | Close dialogs / palette |

### How do I propose doc edits?

Each page footer has **edit**, **issue**, and **source** links to the GitHub repo.

---

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| No dashboard after start | Finish **Start cleanup** — case must be created first |
| Agent blocked | Open **Approvals** — a pending disclosure may need your decision |
| Wrong case | **Cases** sidebar → switch or start new |
| Venice / AI errors | Connect wallet and buy credits in **Settings → Payment rails** |
| Lost case access | Tokens are per-browser — start a new case on a new device |

Still stuck? [Open an issue](https://github.com/thomasjvu/oblivion/issues) on GitHub.

---

[Open Oblivion](https://oblivion.phantasy.bot)