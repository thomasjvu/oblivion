import {
  creditRates,
  creditsBypassEnabled,
  subscriptionActiveForWalletKey,
  walletKeyFromAddress
} from "./credits.js";
import { X402_PRODUCTS } from "./payments/catalog.js";
import { x402PublicConfig } from "./x402.js";
import type { CaseRecord, PaymentSession } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export function activationBypassEnabled(): boolean {
  return creditsBypassEnabled() || process.env.HACKATHON_MODE === "true";
}

export function isCaseActivated(store: MemoryStore, caseId: string): boolean {
  const caseRecord = store.cases.get(caseId);
  if (!caseRecord) return false;
  if (caseRecord.partnerId) return true;
  if (activationBypassEnabled()) return true;
  if (
    caseRecord.activatedWalletKey &&
    subscriptionActiveForWalletKey(store, caseRecord.activatedWalletKey)
  ) {
    return true;
  }
  return store.paymentSessionsForCase(caseId).some((session) => session.status === "paid");
}

export function autoActivateCaseForSubscriptionWallet(
  store: MemoryStore,
  caseRecord: CaseRecord,
  walletAddress: string
): CaseRecord | null {
  if (caseRecord.partnerId || isCaseActivated(store, caseRecord.id)) return caseRecord;
  const walletKey = walletKeyFromAddress(walletAddress);
  if (!subscriptionActiveForWalletKey(store, walletKey)) return null;
  const updated: CaseRecord = {
    ...caseRecord,
    activatedAt: caseRecord.activatedAt ?? new Date().toISOString(),
    activatedWalletKey: walletKey,
    updatedAt: new Date().toISOString()
  };
  store.cases.set(caseRecord.id, updated);
  return updated;
}

export function caseActivationView(store: MemoryStore, caseRecord: CaseRecord) {
  const activated = isCaseActivated(store, caseRecord.id);
  return {
    activated,
    activationRequired: !caseRecord.partnerId && !activated
  };
}

export function markCaseActivated(
  store: MemoryStore,
  caseId: string,
  session: PaymentSession
): CaseRecord {
  const caseRecord = store.getCaseOrThrow(caseId);
  if (caseRecord.partnerId) return caseRecord;
  const walletKey =
    session.walletKey ??
    (session.walletAddress?.startsWith("0x") ? walletKeyFromAddress(session.walletAddress) : undefined);
  const updated: CaseRecord = {
    ...caseRecord,
    activatedAt: caseRecord.activatedAt ?? new Date().toISOString(),
    activatedWalletKey: walletKey ?? caseRecord.activatedWalletKey,
    updatedAt: new Date().toISOString()
  };
  store.cases.set(caseId, updated);
  return updated;
}

export function assertCaseActivated(store: MemoryStore, caseRecord: CaseRecord): void {
  if (caseRecord.partnerId || isCaseActivated(store, caseRecord.id)) return;
  throw Object.assign(new Error("case-activation-required"), {
    statusCode: 402,
    code: "case-activation-required",
    caseId: caseRecord.id,
    products: X402_PRODUCTS,
    rates: creditRates(),
    config: x402PublicConfig()
  });
}

export function activateCaseForTest(
  store: MemoryStore,
  caseId: string,
  walletAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
): PaymentSession {
  const walletKey = walletKeyFromAddress(walletAddress);
  const now = new Date().toISOString();
  const session: PaymentSession = {
    id: `payment_test_${crypto.randomUUID()}`,
    caseId,
    productId: "credit-starter",
    mode: "one-off",
    status: "paid",
    amountUsd: 5,
    token: "USDC",
    network: "base",
    x402Request: {
      version: "x402-v2",
      endpoint: "/api/credits/purchase",
      amountUsd: 5,
      token: "USDC",
      network: "base",
      memo: "test activation",
      expiresAt: now
    },
    erc7710Delegation: {
      standard: "ERC-7710",
      delegate: "PaymentAgent",
      endpoint: "/api/credits/purchase",
      spendCapUsd: 5,
      token: "USDC",
      expiresAt: now,
      scope: ["top-up-credits", "x402-only", "wallet-bound"]
    },
    walletKey,
    walletAddress,
    createdAt: now,
    updatedAt: now
  };
  store.paymentSessions.set(session.id, session);
  markCaseActivated(store, caseId, session);
  return session;
}