# Oblivion — User Guide

Oblivion is a **private cleanup agent**. You describe what was exposed; the agent finds a route, prepares work, and **stops before anything is sent to a third party** until you approve the exact disclosure.

You do not need to understand presets, TEE attestation, or x402 to get started. Follow the five steps below. The **Oblivion panel on the right** (or bottom on mobile) is your main control surface.

---

## Before you start

| What Oblivion does | What Oblivion does not do |
|--------------------|---------------------------|
| Encrypts your private notes in **your browser** before saving | Store your raw email, name, or intake in clear text on the server |
| Recommends a cleanup **route** (people-search, Google, GDPR, etc.) | Automatically remove data without your approval |
| Drafts removals and records approved actions | Guarantee every site will comply |

**Local mode** (default on your machine) is normal: the agent can organize drafts and approvals. **Verified runtime** unlocks sensitive managed checks after attestation passes.

---

## Step 1 — Tell the agent (one message)

1. Open Oblivion (e.g. http://localhost:8080).
2. Click **Start cleanup** (or **Open app**).
3. Type **one sentence** in the big intake box, e.g. *"Remove my old address from people-search sites."*
   - Or tap an **example chip** (People-search, Google, GDPR, Safety).
   - Or type the same thing in the **Oblivion agent** panel and press **Ask**.
4. Click **Start with the agent**.

Oblivion will encrypt your note in the browser, infer jurisdiction and route, **start the cleanup automatically**, and open the workspace.

**Done when:** You see the dashboard and the agent says it is running your route.

**Optional:** Expand **Fine-tune case settings** only if you need to override jurisdiction, label, or risk level.

---

## Step 2 — Find and confirm your listings

The route is already chosen from your message. On **Overview**, use the **Exposure links** panel:

1. Paste any profile URLs you already found (one per line), or click **Discover** to search via Brave (requires `BRAVE_SEARCH_API_KEY` on the server).
2. For each card, click **Confirm** if it is you, or **Not me** to filter it out.
3. Press **Do next step** when no links are left pending.

**Done when:** At least one link is confirmed and the workflow moves past **Confirm matches**.

## Step 3 — Keep the agent running

1. Watch the **guide strip** and **workflow** on Overview.
2. Click **Do next step** whenever the agent is ready.

**Done when:** The agent says **Approval required** or shows an approval card.

The agent may pause for trust checks — keep using **Do next step** after you finish link review.

---

## Step 4 — Approve exact disclosure

This is the safety gate. Nothing sensitive leaves without this step.

1. When the guide shows **Step 4**, click **Do next step** (opens Approvals) or **Review approval** in the agent panel.
2. Read the card:
   - **Destination** (broker, controller, search engine, …)
   - **Data categories** (what would be disclosed — never more than listed)
   - **Purpose** and **expiry**
3. Click **Approve** on the card.
4. Type your confirmation when prompted (this is stored as approval proof, redacted in logs).

**Done when:** The approval clears and the agent can record or continue the route.

**Rule:** If anything looks wrong, do not approve. Adjust the route or intake and run again.

---

## Step 5 — Track and finish

1. Keep using **Run next** until the agent reports the cycle **complete**.
2. Use **Log** only if you want to see recorded actions.
3. **Vault** tab (advanced): export an encrypted backup or delete the case when finished.

**Done when:** Workflow shows complete / recheck scheduled and no pending approvals.

---

## Using the agent panel (your main control)

The **Oblivion** panel is a command surface, not a chatbot for casual conversation.

| Control | When to use it |
|---------|----------------|
| **Do next step** (guide bar) | Always — does the right thing for your current step |
| **Run next** | Same as above, inside the agent panel |
| **Start recommended** | Step 2 — begin the chosen preset |
| **Review approval** | Step 4 — open Approvals |
| **Explain disclosure** | Before approving — plain-language summary |
| Suggestion chips (`run`, `status`, …) | Quick commands under the input |

Type short commands in the input: `run`, `approve`, `status`, `explain`.

---

## Tabs — what matters when

| Tab | Use when |
|-----|----------|
| **Overview** | Default — workflow, metrics, what the agent is doing |
| **Presets** | Changing route or manual approval builder |
| **Approvals** | Step 4 — reviewing disclosure |
| **Vault / Log / Settings** | Advanced — export, raw log, wallet demos, attestation details |

Click **Show advanced tabs** in the guide if you need Vault, Log, or Settings.

---

## Wallet and payments (hackathon)

Wallet connection is **not required** for a normal cleanup, but required for the MetaMask / x402 sponsor tracks.

1. Create a case (**Start with the agent**).
2. On the dashboard, use **Connect & enable Smart Account** in the green **Hackathon wallet** strip (or **Connect MetaMask** in the top bar).
3. Confirm the MetaMask popup. Without an extension, Oblivion uses a **demo wallet** and still records EIP-7702 permissions.
4. Open **Payments** (strip link or agent **Open settings**) for x402 one-off / subscription demos.

Set `WALLET_LIVE_MODE=true` on the server for Sepolia `wallet_sendCalls` upgrade prompts (optional; needs Sepolia ETH).

---

## Glossary (short)

| Term | Meaning |
|------|---------|
| **Case** | One encrypted workspace for one cleanup effort |
| **Preset / route** | Template workflow (people-search, Google, GDPR, …) |
| **Approval** | Your explicit OK for one destination + data categories |
| **Record-only** | Action logged locally; no live submission to third parties |
| **Local mode** | Runtime not TEE-verified; sensitive managed calls blocked |
| **Agent dock** | Right-side panel — primary way to drive the agent |

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| I only see setup, no dashboard | Finish Step 1 — click **Start with the agent** |
| **Do next step** does nothing | Open the agent panel (mobile: tap **Oblivion** at bottom) |
| Stuck on approval | Go to **Approvals** tab; approve or cancel by not approving |
| Too many tabs | Use **Show advanced tabs** only when needed; follow the guide strip |
| Lost | Reset: **New case** or read this guide at `/help` |

---

## Privacy reminders

- Raw identifiers belong in the **encrypted intake** (browser vault), not in destination/purpose fields on the server.
- The server sees redacted summaries and ciphertext only.
- Approved actions may still disclose **exactly** what the approval card lists — read it carefully.

For developers and security details, see `SECURITY.md` and `AGENTS.md`.