# Oblivion — User Guide

Private cleanup agent for people-search listings, breach checks, and search suppression. **Nothing sends until you approve** the exact disclosure.

**Building an app?** [Partner API](/docs/developers/partner-api) · **Choosing a template?** [Templates](/docs/user-guide/templates)

Use the **agent panel** (right on desktop, bottom on mobile). Tap **Continue** when prompted.

```mermaid
flowchart LR
  Start[Start case + vault] --> Discover[Find exposures]
  Discover --> Review[Confirm matches]
  Review --> Approve[Approve disclosure]
  Approve --> Execute[Record or send]
  Execute --> Recheck[Schedule recheck]
```

---

## Start

1. **Start** → name, template, **Start cleanup**
2. Or type one line in the agent panel
3. Dashboard opens with your route running

## Review

1. **Overview** — **Confirm** or **Not me** on each listing
2. Paste URLs or **Search again** if needed
3. **Continue** until approvals appear

## Approve

1. Open **Approvals** (or **Continue**)
2. Read destination, data categories, purpose
3. **Approve** only if it matches your intent — nothing sends without this

---

## Controls

| Button | Does |
|--------|------|
| **Continue** | Next safe step |
| Agent input | `run`, `status`, `explain` |

Sidebar: Overview · Approvals · Settings · Cases

**Wallet** (optional): connect from sidebar for Smart Account / payment demos — not required for cleanup.

---

## Stuck?

| Issue | Fix |
|-------|-----|
| No dashboard | Finish **Start cleanup** |
| Blocked | Check **Approvals** |
| Wrong case | **Cases** → new or switch |