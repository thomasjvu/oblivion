import { createTimelineEvent } from "../agentTimeline.js";
import { markCaseActivated } from "../caseActivation.js";
import { creditsBypassEnabled } from "../credits.js";
import {
  MONITOR_MONTHLY_CREDITS,
  resolveCreditsView,
  settleCreditsForProduct,
  STARTER_PACK_CREDITS
} from "../credits.js";
import { walletKeyFromAddress } from "../credits.js";
import { DomainError } from "../errors.js";
import { markSessionPaid } from "../x402.js";
import type { CaseRecord, PaymentMode, PaymentSession } from "../types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";

export type PaymentSessionClaim = PaymentSession | "already-paid" | null;

export function claimPaymentSessionForSettlement(
  store: MemoryStore,
  sessionId: string,
  settlementTransaction?: string
): PaymentSessionClaim {
  const session = store.paymentSessions.get(sessionId);
  if (!session) return null;
  if (session.status === "paid") return "already-paid";
  if (session.status !== "payment-required") return null;
  const paid = markSessionPaid(session, settlementTransaction);
  store.paymentSessions.set(sessionId, paid);
  return paid;
}

function resolveSettlementSession(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    expectedMode: PaymentMode;
    paymentSessionId?: string;
    settlementTransaction?: string;
  }
): PaymentSession | null {
  if (input.paymentSessionId) {
    const session = store.paymentSessions.get(input.paymentSessionId);
    if (!session || session.caseId !== caseRecord.id || session.mode !== input.expectedMode) {
      return null;
    }
    return session;
  }
  const candidates = store.paymentSessionsForCase(caseRecord.id).filter((item) => {
    if (item.mode !== input.expectedMode) return false;
    if (input.settlementTransaction) return Boolean(item.walletKey);
    return true;
  });
  if (candidates.length > 1) {
    throw new DomainError("payment-session-ambiguous", 422);
  }
  return candidates[0] ?? null;
}

export function settleCreditProduct(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    walletAddress: string;
    expectedMode: PaymentMode;
    paymentSessionId?: string;
    settlementTransaction?: string;
  }
) {
  const session = resolveSettlementSession(store, caseRecord, input);
  if (!session) {
    return null;
  }
  if (!input.settlementTransaction && !creditsBypassEnabled()) {
    return null;
  }
  const billingWallet = session.walletAddress ?? input.walletAddress;
  if (
    session.walletAddress &&
    input.walletAddress &&
    walletKeyFromAddress(session.walletAddress) !== walletKeyFromAddress(input.walletAddress)
  ) {
    return null;
  }
  const claim = claimPaymentSessionForSettlement(store, session.id, input.settlementTransaction);
  if (claim === null) {
    return null;
  }
  if (claim === "already-paid") {
    const credits = resolveCreditsView(store, input.walletAddress);
    return {
      session,
      credits,
      balanceCredits: credits.balanceCredits
    };
  }
  const paid = claim;
  markCaseActivated(store, caseRecord.id, paid);
  const credits = settleCreditsForProduct(store, billingWallet, input.expectedMode, caseRecord.id);
  const timeline = createTimelineEvent(
    caseRecord.id,
    "x402",
    input.expectedMode === "subscription"
      ? input.settlementTransaction
        ? "Monitor credits refilled via x402"
        : "Monitor credits refilled"
      : input.settlementTransaction
        ? "Starter credits purchased via x402"
        : "Starter credits purchased",
    `Wallet credited ${input.expectedMode === "subscription" ? MONITOR_MONTHLY_CREDITS : STARTER_PACK_CREDITS} credits.`
  );
  store.agentTimeline.set(timeline.id, timeline);
  return {
    session: paid,
    credits: resolveCreditsView(store, input.walletAddress),
    balanceCredits: credits.balanceCredits,
    timeline
  };
}

export function findCreditSession(
  store: MemoryStore,
  caseRecord: CaseRecord,
  expectedMode: PaymentMode,
  paymentSessionId?: string
): PaymentSession | undefined {
  const sessions = store.paymentSessionsForCase(caseRecord.id);
  const session = paymentSessionId ? store.paymentSessions.get(paymentSessionId) : undefined;
  if (session) return session;
  return sessions.find((item) => item.mode === expectedMode);
}