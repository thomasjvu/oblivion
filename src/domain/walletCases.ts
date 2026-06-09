import { publicCaseView } from "./cases.js";
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
    throw Object.assign(new Error("wallet-address-invalid"), { statusCode: 422 });
  }
  const walletKey = walletKeyFromAddress(walletAddress);
  const paidSession = store
    .paymentSessionsForCase(caseRecord.id)
    .find((session) => session.status === "paid" && session.walletKey === walletKey);
  if (!paidSession && caseRecord.activatedWalletKey && caseRecord.activatedWalletKey !== walletKey) {
    throw Object.assign(new Error("wallet-case-mismatch"), { statusCode: 403 });
  }
  const updated: CaseRecord = {
    ...caseRecord,
    activatedWalletKey: walletKey,
    updatedAt: new Date().toISOString()
  };
  store.cases.set(caseRecord.id, updated);
  return updated;
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