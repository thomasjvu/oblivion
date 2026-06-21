import { publicCaseView } from "./cases.js";
import { DomainError } from "./errors.js";
import { walletKeyFromAddress } from "./credits.js";
import type { CaseRecord } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export interface WalletCaseSummary {
  id: string;
  personLabel?: string;
  jurisdiction: CaseRecord["jurisdiction"];
  activatedAt?: string;
  updatedAt: string;
  createdAt: string;
}

export function linkCaseToWallet(
  store: MemoryStore,
  caseRecord: CaseRecord,
  walletAddress: string
): CaseRecord {
  if (!walletAddress.startsWith("0x")) {
    throw new DomainError("wallet-address-invalid", 422);
  }
  const walletKey = walletKeyFromAddress(walletAddress);
  const paidSession = store
    .paymentSessionsForCase(caseRecord.id)
    .find((session) => session.status === "paid" && session.walletKey === walletKey);
  if (!paidSession && caseRecord.activatedWalletKey && caseRecord.activatedWalletKey !== walletKey) {
    throw new DomainError("wallet-case-mismatch", 403);
  }
  const updated: CaseRecord = {
    ...caseRecord,
    activatedWalletKey: walletKey,
    linkedWalletAddress: walletAddress,
    updatedAt: new Date().toISOString()
  };
  store.cases.set(caseRecord.id, updated);
  return updated;
}

export function authorizedWalletAddresses(store: MemoryStore, caseRecord: CaseRecord): string[] {
  const addresses = new Set<string>();
  for (const session of store.paymentSessionsForCase(caseRecord.id)) {
    if (session.walletAddress?.startsWith("0x")) {
      addresses.add(session.walletAddress.toLowerCase());
    }
  }
  if (caseRecord.linkedWalletAddress?.startsWith("0x")) {
    addresses.add(caseRecord.linkedWalletAddress.toLowerCase());
  }
  return [...addresses];
}

export function requireBillingWalletAddress(
  store: MemoryStore,
  caseRecord: CaseRecord,
  requested?: string
): string {
  const authorized = authorizedWalletAddresses(store, caseRecord);
  if (authorized.length === 0) {
    throw new DomainError("wallet-link-required", 422, {
      message: "Link a wallet or complete payment before spending credits on this case."
    });
  }
  if (requested?.startsWith("0x")) {
    if (!authorized.includes(requested.toLowerCase())) {
      throw new DomainError("wallet-not-authorized-for-case", 403);
    }
    return requested;
  }
  const session = store
    .paymentSessionsForCase(caseRecord.id)
    .filter((item) => item.walletAddress?.startsWith("0x"))
    .at(-1);
  const fallback = session?.walletAddress ?? caseRecord.linkedWalletAddress;
  if (!fallback?.startsWith("0x")) {
    throw new DomainError("wallet-address-required", 422);
  }
  return fallback;
}

export function casesForWallet(store: MemoryStore, walletAddress: string): WalletCaseSummary[] {
  const walletKey = walletKeyFromAddress(walletAddress);
  return [...store.cases.values()]
    .filter((caseRecord) => !caseRecord.deletedAt && caseRecord.activatedWalletKey === walletKey)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((caseRecord) => {
      const view = publicCaseView(caseRecord);
      return {
        id: caseRecord.id,
        personLabel: view.redactedScope?.personLabel,
        jurisdiction: caseRecord.jurisdiction,
        activatedAt: caseRecord.activatedAt,
        updatedAt: caseRecord.updatedAt,
        createdAt: caseRecord.createdAt
      };
    });
}

export function walletAddressForCase(store: MemoryStore, caseId: string): string | undefined {
  const sessions = store
    .paymentSessionsForCase(caseId)
    .filter((session) => session.status === "paid" && session.walletAddress?.startsWith("0x"));
  return sessions[sessions.length - 1]?.walletAddress;
}