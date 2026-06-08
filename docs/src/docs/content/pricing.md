# Pricing

**USDC on Base** via x402 + scoped ERC-7710 permissions. Payment unlocks agent capacity — **not** unsupervised disclosure. Every cleanup still needs your explicit approval.

```mermaid
flowchart LR
  Plan[Pick plan] --> Wallet[Connect wallet]
  Wallet --> Session[x402 session]
  Session --> Agent[Agent + AI limits]
  Agent --> Approve[You approve each send]
```

## Plans

| Plan | Price | Best for |
|------|-------|----------|
| **One-off** | **$5 USDC** | Single supervised cleanup |
| **Subscription** | **$10 USDC/mo** | Weekly rechecks + higher AI limits |

| Feature | One-off | Subscription |
|---------|---------|--------------|
| Agent chats | 5 | 30 |
| AI analysis tasks | 1 | 6 |
| Token cap / case | 280 | 400 |
| Recheck cadence | Per preset | Weekly monitor |
| ERC-7710 delegation | — | Scoped monitor invoices |

## How it works

1. Choose plan when creating a case
2. Connect wallet if prompted (Smart Account optional)
3. Oblivion prepares an x402 session bound to the case
4. AI features stay capped until session is **authorized** or **paid**

## FAQ

**Switch later?** Settings → Payment rails.

**Bypass approvals?** No — payment funds assistance only.

**URLs only?** Discovery works on both plans; subscription adds monitoring + AI headroom.

[Open Oblivion](https://oblivion.phantasy.bot)