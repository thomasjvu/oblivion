# Cleanup Templates

Pick the goal that matches your cleanup. Each template asks for different identifiers and follows the same supervised workflow: discover, review, approve, then record or send.

[User guide](/docs/user-guide/overview)

```mermaid
flowchart TB
  subgraph intake["1 · Intake"]
    A[Encrypt in browser] --> B[Trust check]
  end

  subgraph discover["2 · Discover"]
    B --> C[Find exposures]
    C --> D{Review matches?}
    D -->|yes| E[Confirm links]
    D -->|skip| F[Plan removal]
    E --> F
  end

  subgraph act["3 · Act"]
    F --> G[Draft request]
    G --> H[You approve]
    H --> I[Record or send]
    I --> J[Schedule recheck]
  end
```

---

## Pick a template

| Goal | Template | What you provide | Review each match? |
|------|----------|------------------|-------------------|
| Remove people-search listings | People-search cleanup | Name, email, city/state | Yes |
| Hide Google results | Search suppression | Name, email | No |
| California DROP request | California DROP | Name, email, address | No |
| EU/UK erasure | GDPR erasure | Name, email | No |
| Breach check | Breach exposure | Email | No |
| Urgent address or relative exposure | High-risk safety | Name, address, relative | Yes |
| Copied content takedown | Content takedown | Name, email, URL, work reference | Yes |

Integrators: preset IDs and API details are in the [Partner API](/docs/developers/partner-api).

---

## What happens on every template

| Phase | What you experience |
|-------|---------------------|
| **Encrypt** | Identifiers stay in your browser vault; the server sees ciphertext and redacted labels only |
| **Trust check** | Production deployments verify hardware attestation before sensitive live sends |
| **Discover** | Oblivion finds candidate listings, breach signals, or guidance URLs |
| **Review** | You confirm or reject each match (some templates skip this) |
| **Plan removal** | Official opt-out, suppression, or rights paths are identified |
| **Draft** | Request text is prepared; AI can refine if you have credits |
| **Approve** | You read each disclosure card — nothing sends without your confirmation |
| **Execute** | Default is a logged practice run with handoff steps; live sends need trust verification + approval |
| **Follow up** | Replies are tracked; recheck is scheduled (typically 14–90 days) |
| **Complete** | Case finishes; you can return later if listings reappear |

**Autonomy:** Default mode shows one approval per destination. High-autonomy batches cards — you still approve each batch explicitly.

---

## What each template focuses on

- **People-search cleanup** — broker listings, opt-out paths, California DROP guidance where relevant
- **Search suppression** — Google removal planning; you complete submission on Google’s site
- **California DROP** — guided state registry workflow
- **GDPR erasure** — erasure templates plus search suppression planning
- **Breach exposure** — email breach check; password check uses prefix-only ranges, never full passwords
- **High-risk safety** — same discovery family as people-search with stricter match review
- **Content takedown** — DMCA-style drafts and platform abuse paths

---

## Never automatic

- Raw identifiers leaving the vault without your approval
- Live email or broker submission without production trust verification
- Passwords, SSNs, or breach-dump searches
- Broad consent — each action names destination, categories, purpose, and expiry

---

## Practice run vs live send

| Mode | What it means |
|------|----------------|
| **Practice run** (default) | Actions are logged with clear handoff instructions for you to complete |
| **Live send** | After you approve, Oblivion may transmit only the approved data — requires production trust verification |

[Open Oblivion](https://oblivion.phantasy.bot)