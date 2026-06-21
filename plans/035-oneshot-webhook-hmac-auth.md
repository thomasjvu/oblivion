# Plan 035: Fix 1Shot webhook HMAC verification

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 10d15ae..HEAD -- src/domain/oneshotWebhookAuth.ts src/api/routes/consumer/integrations/oneshot.ts test/domain/oneshotWebhookAuth.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `10d15ae`, 2026-06-21

## Why this matters

Plan 004 marked 1Shot webhook auth DONE, but `verifyOneShotWebhookSignature` compares the request `signature` field to the raw shared secret via `timingSafeEqual`, not an HMAC of the body. `signOneShotWebhookProbe` computes HMAC-SHA256 but is never used by the handler. Anyone with the session callback token (from `GET /api/1shot/webhook-url`) and knowledge of the API secret can forge relayer events.

**Operational note**: after deploy, rotate `ONESHOT_WEBHOOK_SECRET` / `ONESHOT_API_KEY` via Infisical — do not record secret values in code or plans.

## Current state

```23:38:src/domain/oneshotWebhookAuth.ts
export function verifyOneShotWebhookSignature(payloadSignature: string | undefined): boolean {
  const secret = process.env.ONESHOT_WEBHOOK_SECRET?.trim() || process.env.ONESHOT_API_KEY?.trim();
  // ...
  const left = Buffer.from(secret);
  const right = Buffer.from(payloadSignature);
  return timingSafeEqual(left, right);
}

export function signOneShotWebhookProbe(body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
```

- `src/api/routes/consumer/integrations/oneshot.ts:107-108` — calls `verifyOneShotWebhookSignature(body.signature)` on parsed JSON, not raw body bytes.
- `test/api/oneshot-auth.test.ts` — only 401 for missing token; no signature tests.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `npm test -- test/domain/oneshotWebhookAuth.test.ts test/api/oneshot-auth.test.ts` | pass |
| Verify | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `src/domain/oneshotWebhookAuth.ts`
- `src/api/routes/consumer/integrations/oneshot.ts` (pass raw body to verify)
- New `test/domain/oneshotWebhookAuth.test.ts`
- Extend `test/api/oneshot-auth.test.ts`

**Out of scope**:
- 1Shot RPC proxy auth (plan 003 — already done)
- Provider event schema validation beyond signature

## Steps

### Step 1: Confirm 1Shot signature contract

Read `src/domain/oneshotWebhook.ts` and any docs/comments for the expected signature scheme. Default implementation: HMAC-SHA256 of raw request body with `ONESHOT_WEBHOOK_SECRET` (use existing `signOneShotWebhookProbe`).

If live 1Shot uses a different header or algorithm, STOP and report with evidence.

**Verify**: document chosen scheme in test file comment only (no secrets)

### Step 2: Fix verify to use HMAC

Change `verifyOneShotWebhookSignature` to accept `(rawBody: string, payloadSignature: string | undefined): boolean`:
- Compute `expected = signOneShotWebhookProbe(rawBody)`
- Constant-time compare `expected` to `payloadSignature`
- Reject when secret missing in production with 1Shot configured

**Verify**: `npm test -- test/domain/oneshotWebhookAuth.test.ts` → pass

### Step 3: Pass raw body from route handler

In `oneshot.ts` webhook handler, read raw body string before JSON parse (or re-serialize consistently — prefer raw bytes). Call verify with raw body + `body.signature`.

Match pattern from partner webhook signature tests if any exist in `test/domain/webhook-delivery.test.ts`.

**Verify**: `npm test -- test/api/oneshot-auth.test.ts` → pass

### Step 4: Negative tests

Add tests:
- Valid HMAC → 200/201 (with valid session token)
- Wrong signature → 401 `oneshot-webhook-signature-invalid`
- Raw secret as signature → 401 (regression for old bug)

**Verify**: `npm run verify` → exit 0

## Test plan

- Unit: sign + verify round-trip
- API: forged event without valid HMAC rejected

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] Raw-secret acceptance no longer possible
- [ ] `plans/README.md` row 035 → DONE

## STOP conditions

- 1Shot production relayer sends signatures that do not match HMAC-of-body — need contract clarification.
- Handler cannot access raw body without refactoring `readJson` — use buffer read pattern from other webhook routes.

## Maintenance notes

Document in `SECURITY.md` that operators must rotate 1Shot secrets after this fix. Any change to body parsing invalidates HMAC — keep verify on raw bytes.