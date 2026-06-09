import { createHash } from "node:crypto";
import type { MemoryStore } from "../storage/memoryStore.js";
import { sanitizeForLog } from "./safeLogging.js";
import type { CreditAccount, CreditLedgerEntry, CreditLedgerKind } from "./types.js";

export const CREDITS_PER_USD = Number(process.env.OBLIVION_CREDITS_PER_USD || "100");
export const STARTER_PACK_CREDITS = Number(process.env.OBLIVION_STARTER_PACK_CREDITS || "500");
export const MONITOR_MONTHLY_CREDITS = Number(process.env.OBLIVION_MONITOR_MONTHLY_CREDITS || "1200");
export const CREDITS_PER_100_TOKENS = Number(process.env.OBLIVION_CREDITS_PER_100_TOKENS || "1");
export const EMAIL_RELAY_CREDITS = Number(process.env.OBLIVION_EMAIL_RELAY_CREDITS || "25");
export const DISCOVERY_CREDITS = Number(process.env.OBLIVION_DISCOVERY_CREDITS || "15");

export interface CreditRates {
  creditsPerUsd: number;
  starterPackCredits: number;
  monitorMonthlyCredits: number;
  creditsPer100Tokens: number;
  emailRelayCredits: number;
  discoveryCredits: number;
}

export interface CreditsView {
  walletKey: string;
  balanceCredits: number;
  subscriptionActive: boolean;
  subscriptionExpiresAt?: string;
  rates: CreditRates;
}

export function discoveryCredits(): number {
  return Number.isFinite(DISCOVERY_CREDITS) && DISCOVERY_CREDITS > 0
    ? Math.floor(DISCOVERY_CREDITS)
    : 15;
}

export function creditRates(): CreditRates {
  return {
    creditsPerUsd: CREDITS_PER_USD,
    starterPackCredits: STARTER_PACK_CREDITS,
    monitorMonthlyCredits: MONITOR_MONTHLY_CREDITS,
    creditsPer100Tokens: CREDITS_PER_100_TOKENS,
    emailRelayCredits: EMAIL_RELAY_CREDITS,
    discoveryCredits: discoveryCredits()
  };
}

export function walletKeyFromAddress(walletAddress: string): string {
  const normalized = walletAddress.trim().toLowerCase();
  if (!normalized.startsWith("0x") || normalized.length !== 42) {
    throw Object.assign(new Error("wallet-address-invalid"), { statusCode: 422 });
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function subscriptionActive(account: CreditAccount): boolean {
  if (!account.subscriptionExpiresAt) return false;
  return new Date(account.subscriptionExpiresAt).getTime() > Date.now();
}

export function subscriptionActiveForWalletKey(store: MemoryStore, walletKey: string): boolean {
  const account = store.creditAccounts.get(walletKey);
  return account ? subscriptionActive(account) : false;
}

export function getOrCreateCreditAccount(store: MemoryStore, walletAddress: string): CreditAccount {
  const walletKey = walletKeyFromAddress(walletAddress);
  const existing = store.creditAccounts.get(walletKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const account: CreditAccount = {
    id: `credit_${walletKey.slice(0, 16)}`,
    walletKey,
    balanceCredits: 0,
    updatedAt: now
  };
  store.creditAccounts.set(walletKey, account);
  return account;
}

export function creditAccountForWallet(store: MemoryStore, walletAddress: string): CreditAccount | undefined {
  const walletKey = walletKeyFromAddress(walletAddress);
  return store.creditAccounts.get(walletKey);
}

export function creditWallet(
  store: MemoryStore,
  walletKey: string,
  credits: number,
  entry: Omit<CreditLedgerEntry, "id" | "walletKey" | "credits" | "createdAt">
): CreditAccount {
  if (!Number.isFinite(credits) || credits <= 0) {
    throw Object.assign(new Error("credit-amount-invalid"), { statusCode: 422 });
  }
  const account = store.creditAccounts.get(walletKey);
  if (!account) {
    throw Object.assign(new Error("credit-account-not-found"), { statusCode: 404 });
  }
  const now = new Date().toISOString();
  const ledgerEntry: CreditLedgerEntry = {
    id: `ledger_${crypto.randomUUID()}`,
    walletKey,
    credits,
    createdAt: now,
    ...entry,
    meta: entry.meta ? sanitizeLedgerMeta(entry.meta) : undefined
  };
  store.creditLedger.set(ledgerEntry.id, ledgerEntry);
  const updated: CreditAccount = {
    ...account,
    balanceCredits: account.balanceCredits + credits,
    updatedAt: now
  };
  if (entry.kind === "subscription-refill" && entry.subscriptionExpiresAt) {
    updated.subscriptionExpiresAt = entry.subscriptionExpiresAt;
  }
  store.creditAccounts.set(walletKey, updated);
  return updated;
}

export function debitCredits(
  store: MemoryStore,
  walletKey: string,
  credits: number,
  entry: Omit<CreditLedgerEntry, "id" | "walletKey" | "credits" | "createdAt">
): CreditAccount {
  if (!Number.isFinite(credits) || credits <= 0) {
    throw Object.assign(new Error("debit-amount-invalid"), { statusCode: 422 });
  }
  const account = store.creditAccounts.get(walletKey);
  if (!account || account.balanceCredits < credits) {
    throw Object.assign(new Error("credits-insufficient"), {
      statusCode: 402,
      code: "credits-insufficient",
      balanceCredits: account?.balanceCredits ?? 0,
      requiredCredits: credits
    });
  }
  const now = new Date().toISOString();
  const ledgerEntry: CreditLedgerEntry = {
    id: `ledger_${crypto.randomUUID()}`,
    walletKey,
    credits: -credits,
    createdAt: now,
    ...entry,
    meta: entry.meta ? sanitizeLedgerMeta(entry.meta) : undefined
  };
  store.creditLedger.set(ledgerEntry.id, ledgerEntry);
  const updated: CreditAccount = {
    ...account,
    balanceCredits: account.balanceCredits - credits,
    updatedAt: now
  };
  store.creditAccounts.set(walletKey, updated);
  return updated;
}

function sanitizeLedgerMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase().includes("wallet") || key.toLowerCase().includes("email")) continue;
    sanitized[key] = typeof value === "string" ? sanitizeForLog(value) : value;
  }
  return sanitized;
}

export function creditsForTokens(tokensUsed: number): number {
  const tokens = Math.max(1, Math.ceil(tokensUsed));
  return Math.max(1, Math.ceil((tokens / 100) * CREDITS_PER_100_TOKENS));
}

export function assertCreditsForTokens(store: MemoryStore, walletAddress: string, tokensEstimate = 100): CreditAccount {
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  const account = getOrCreateCreditAccount(store, walletAddress);
  const required = creditsForTokens(tokensEstimate);
  if (account.balanceCredits < required) {
    throw Object.assign(new Error("credits-insufficient"), {
      statusCode: 402,
      code: "credits-insufficient",
      balanceCredits: account.balanceCredits,
      requiredCredits: required
    });
  }
  return account;
}

export function assertCreditsForEmailRelay(store: MemoryStore, walletAddress: string): CreditAccount {
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  const account = getOrCreateCreditAccount(store, walletAddress);
  if (account.balanceCredits < EMAIL_RELAY_CREDITS) {
    throw Object.assign(new Error("credits-insufficient"), {
      statusCode: 402,
      code: "credits-insufficient",
      balanceCredits: account.balanceCredits,
      requiredCredits: EMAIL_RELAY_CREDITS
    });
  }
  return account;
}

export function debitCreditsForTokens(
  store: MemoryStore,
  walletAddress: string,
  tokensUsed: number,
  meta: { caseId?: string; kind?: CreditLedgerKind }
): CreditAccount {
  const walletKey = walletKeyFromAddress(walletAddress);
  const credits = creditsForTokens(tokensUsed);
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  return debitCredits(store, walletKey, credits, {
    kind: meta.kind ?? "token",
    caseId: meta.caseId,
    meta: { tokensUsed }
  });
}

export function debitCreditsForEmailRelay(
  store: MemoryStore,
  walletAddress: string,
  caseId: string
): CreditAccount {
  const walletKey = walletKeyFromAddress(walletAddress);
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  return debitCredits(store, walletKey, EMAIL_RELAY_CREDITS, {
    kind: "email",
    caseId,
    meta: { relay: "operator" }
  });
}

export function assertCreditsForDiscovery(store: MemoryStore, walletAddress: string): CreditAccount {
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  const account = getOrCreateCreditAccount(store, walletAddress);
  const required = discoveryCredits();
  if (account.balanceCredits < required) {
    throw Object.assign(new Error("credits-insufficient"), {
      statusCode: 402,
      code: "credits-insufficient",
      balanceCredits: account.balanceCredits,
      requiredCredits: required
    });
  }
  return account;
}

export function debitCreditsForDiscovery(
  store: MemoryStore,
  walletAddress: string,
  caseId: string
): CreditAccount {
  const walletKey = walletKeyFromAddress(walletAddress);
  if (creditsBypassEnabled()) {
    return getOrCreateCreditAccount(store, walletAddress);
  }
  const credits = discoveryCredits();
  return debitCredits(store, walletKey, credits, {
    kind: "discovery",
    caseId,
    meta: { sweep: "broker" }
  });
}

export function settleCreditsForProduct(
  store: MemoryStore,
  walletAddress: string,
  mode: "one-off" | "subscription",
  caseId?: string
): CreditAccount {
  const walletKey = walletKeyFromAddress(walletAddress);
  const account = getOrCreateCreditAccount(store, walletAddress);
  if (mode === "subscription") {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return creditWallet(store, walletKey, MONITOR_MONTHLY_CREDITS, {
      kind: "subscription-refill",
      caseId,
      subscriptionExpiresAt: expiresAt,
      meta: { product: "credit-monitor" }
    });
  }
  return creditWallet(store, walletKey, STARTER_PACK_CREDITS, {
    kind: "purchase",
    caseId,
    meta: { product: "credit-starter" }
  });
}

export function resolveCreditsView(store: MemoryStore, walletAddress: string): CreditsView {
  const account = getOrCreateCreditAccount(store, walletAddress);
  return {
    walletKey: account.walletKey,
    balanceCredits: account.balanceCredits,
    subscriptionActive: subscriptionActive(account),
    subscriptionExpiresAt: account.subscriptionExpiresAt,
    rates: creditRates()
  };
}

export function paymentSessionsForWallet(store: MemoryStore, walletKey: string) {
  return [...store.paymentSessions.values()].filter((session) => session.walletKey === walletKey);
}

export function walletHasCreditsOrPayment(store: MemoryStore, walletAddress?: string): boolean {
  if (!walletAddress) return false;
  try {
    const account = creditAccountForWallet(store, walletAddress);
    if (account && account.balanceCredits > 0) return true;
    const walletKey = walletKeyFromAddress(walletAddress);
    return paymentSessionsForWallet(store, walletKey).some((session) => session.status === "paid");
  } catch {
    return false;
  }
}

export function creditsBypassEnabled(): boolean {
  return process.env.OBLIVION_CREDITS_BYPASS === "true" || process.env.OBLIVION_AI_BYPASS_PAYMENT === "true";
}

export function maxTokensForCredits(balanceCredits: number): number {
  if (balanceCredits <= 0) return 280;
  const tokenBudget = Math.floor((balanceCredits / CREDITS_PER_100_TOKENS) * 100);
  return Math.min(Math.max(tokenBudget, 120), 4000);
}