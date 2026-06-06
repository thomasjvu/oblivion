import type { MemoryStore } from "../storage/memoryStore.js";
import type { PaymentMode, PaymentSession } from "./types.js";

export interface AiBudgetLimits {
  maxChats: number;
  maxAnalyses: number;
  maxTokens: number;
}

export const AI_BUDGET_BY_MODE: Record<PaymentMode, AiBudgetLimits> = {
  "one-off": { maxChats: 5, maxAnalyses: 1, maxTokens: 280 },
  subscription: { maxChats: 30, maxAnalyses: 6, maxTokens: 400 }
};

export interface AiUsageSnapshot {
  chats: number;
  analyses: number;
}

export interface AiEntitlementView {
  mode: PaymentMode | null;
  session: PaymentSession | null;
  limits: AiBudgetLimits | null;
  usage: AiUsageSnapshot;
}

function isEntitledSession(session: PaymentSession): boolean {
  if (session.status !== "paid" && session.status !== "authorized") return false;
  const expiresAt = session.x402Request?.expiresAt || session.erc7710Delegation?.expiresAt;
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > Date.now();
}

export function aiUsageForCase(store: MemoryStore, caseId: string): AiUsageSnapshot {
  const chats = store
    .agentTimelineForCase(caseId)
    .filter((event) => event.actor === "Venice" && event.title === "Agent reply").length;
  const analyses = store.veniceAnalysesForCase(caseId).length;
  return { chats, analyses };
}

export function resolveAiEntitlement(store: MemoryStore, caseId: string): AiEntitlementView {
  const usage = aiUsageForCase(store, caseId);
  const sessions = store.paymentSessionsForCase(caseId).filter(isEntitledSession);
  const subscription = sessions.find((session) => session.mode === "subscription");
  const oneOff = sessions.find((session) => session.mode === "one-off");
  const active = subscription || oneOff || null;
  if (!active) {
    return { mode: null, session: null, limits: null, usage };
  }
  return {
    mode: active.mode,
    session: active,
    limits: AI_BUDGET_BY_MODE[active.mode],
    usage
  };
}

export function aiBypassPaymentEnabled(): boolean {
  return process.env.OBLIVION_AI_BYPASS_PAYMENT === "true";
}

export function assertAiBudget(
  store: MemoryStore,
  caseId: string,
  kind: "chat" | "analysis"
): AiEntitlementView {
  if (aiBypassPaymentEnabled()) {
    const usage = aiUsageForCase(store, caseId);
    return {
      mode: "one-off",
      session: null,
      limits: AI_BUDGET_BY_MODE["one-off"],
      usage
    };
  }
  const entitlement = resolveAiEntitlement(store, caseId);
  if (!entitlement.limits || !entitlement.mode) {
    throw Object.assign(new Error("ai-payment-required"), {
      statusCode: 402,
      code: "ai-payment-required",
      usage: entitlement.usage
    });
  }
  const { limits, usage } = entitlement;
  if (kind === "chat" && usage.chats >= limits.maxChats) {
    throw Object.assign(new Error("ai-chat-budget-exhausted"), {
      statusCode: 402,
      code: "ai-chat-budget-exhausted",
      limits,
      usage
    });
  }
  if (kind === "analysis" && usage.analyses >= limits.maxAnalyses) {
    throw Object.assign(new Error("ai-analysis-budget-exhausted"), {
      statusCode: 402,
      code: "ai-analysis-budget-exhausted",
      limits,
      usage
    });
  }
  return entitlement;
}

export function maxTokensForEntitlement(entitlement: AiEntitlementView): number {
  if (entitlement.limits?.maxTokens) return entitlement.limits.maxTokens;
  return AI_BUDGET_BY_MODE["one-off"].maxTokens;
}