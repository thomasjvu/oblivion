import { createTimelineEvent } from "../agentTimeline.js";
import { markCaseActivated } from "../caseActivation.js";
import {
  MONITOR_MONTHLY_CREDITS,
  resolveCreditsView,
  settleCreditsForProduct,
  STARTER_PACK_CREDITS
} from "../credits.js";
import { markSessionPaid } from "../x402.js";
import type { CaseRecord, PaymentMode, PaymentSession } from "../types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";

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
  const sessions = store.paymentSessionsForCase(caseRecord.id);
  const session = input.paymentSessionId
    ? store.paymentSessions.get(input.paymentSessionId)
    : sessions.find(
        (item) => item.mode === input.expectedMode && (!input.settlementTransaction || Boolean(item.walletKey))
      );
  if (!session || session.caseId !== caseRecord.id || session.mode !== input.expectedMode) {
    return null;
  }
  const paid = markSessionPaid(session, input.settlementTransaction);
  store.paymentSessions.set(paid.id, paid);
  markCaseActivated(store, caseRecord.id, paid);
  const credits = settleCreditsForProduct(store, input.walletAddress, input.expectedMode, caseRecord.id);
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