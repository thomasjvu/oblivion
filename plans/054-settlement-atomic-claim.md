# Plan 054: Settlement atomic claim / idempotency

## Status: DONE

## Problem

Plan 028 short-circuited already-paid sessions but did not atomically claim `payment-required` → `paid` before crediting. Concurrent settlement calls could still double-credit. Ambiguous session resolution (multiple sessions per case without `paymentSessionId`) could settle the wrong session.

## Solution

- `claimPaymentSessionForSettlement()` — marks session `paid` via `markSessionPaid` before `settleCreditsForProduct`; returns `"already-paid"` on replay.
- `resolveSettlementSession()` — throws `DomainError("payment-session-ambiguous", 422)` when multiple sessions match without explicit `paymentSessionId`.
- `settleCreditProduct` uses claim result; already-paid path returns credits view without ledger mutation.

## Files

- `src/domain/payments/settlement.ts`
- `test/domain/payments-settlement.test.ts`

## Verify

`npm test -- test/domain/payments-settlement.test.ts`