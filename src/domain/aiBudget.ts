import type { MemoryStore } from "../storage/memoryStore.js";
import {
  assertCreditsForTokens,
  creditsBypassEnabled,
  maxTokensForCredits,
  resolveCreditsView
} from "./credits.js";

export interface AiEntitlementView {
  balanceCredits: number;
  maxTokens: number;
  bypass: boolean;
}

export function resolveAiEntitlement(store: MemoryStore, walletAddress?: string): AiEntitlementView {
  if (!walletAddress) {
    return { balanceCredits: 0, maxTokens: 280, bypass: creditsBypassEnabled() };
  }
  const view = resolveCreditsView(store, walletAddress);
  return {
    balanceCredits: view.balanceCredits,
    maxTokens: maxTokensForCredits(view.balanceCredits),
    bypass: creditsBypassEnabled()
  };
}

export function assertAiBudget(
  store: MemoryStore,
  walletAddress: string,
  _kind: "chat" | "analysis" = "chat"
): AiEntitlementView {
  const account = assertCreditsForTokens(store, walletAddress, 100);
  return {
    balanceCredits: account.balanceCredits,
    maxTokens: maxTokensForCredits(account.balanceCredits),
    bypass: creditsBypassEnabled()
  };
}

export function maxTokensForEntitlement(entitlement: AiEntitlementView): number {
  return entitlement.maxTokens;
}

export const AI_BUDGET_BY_MODE = {
  "one-off": { maxChats: 0, maxAnalyses: 0, maxTokens: 280 },
  subscription: { maxChats: 0, maxAnalyses: 0, maxTokens: 4000 }
};