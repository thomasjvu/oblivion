import { assertAiBudget, maxTokensForEntitlement } from "../../domain/aiBudget.js";
import { debitCreditsForTokens, resolveCreditsView } from "../../domain/credits.js";
import { createTimelineEvent } from "../../domain/agentTimeline.js";
import { X402_PRODUCTS } from "../../domain/payments/catalog.js";
import { assertPartnerAiBudget, meterPartnerAiTokens } from "../../domain/partnerBilling.js";
import type { ActionType, CaseRecord, VeniceAnalysisKind } from "../../domain/types.js";
import { isVeniceConfigured, runVeniceAgentReply, runVeniceAnalysis } from "../../domain/venice.js";
import { x402PublicConfig } from "../../domain/x402.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { HttpError } from "../errors.js";

export async function meterVeniceChat(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: { message: string; walletAddress?: string }
) {
  if (!isVeniceConfigured()) {
    throw new HttpError(503, "venice-not-configured", {
      message: "Set VENICE_API_KEY to enable the live agent."
    });
  }
  const plan = store.agentPlanForCase(caseRecord.id);
  let maxTokens = 800;
  if (caseRecord.partnerId) {
    assertPartnerAiBudget(store, caseRecord.id);
  } else {
    if (!input.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    let entitlement;
    try {
      entitlement = assertAiBudget(store, input.walletAddress, "chat");
    } catch (error) {
      const err = error as Error & { statusCode?: number; code?: string };
      if (err.statusCode === 402) {
        throw new HttpError(402, err.code || "credits-insufficient", {
          products: X402_PRODUCTS,
          credits: resolveCreditsView(store, input.walletAddress),
          config: x402PublicConfig()
        });
      }
      throw error;
    }
    maxTokens = maxTokensForEntitlement(entitlement);
  }
  const venice = await runVeniceAgentReply({
    caseId: caseRecord.id,
    message: input.message,
    planStep: plan?.currentStep,
    presetId: plan?.presetId,
    maxTokens
  });
  let balanceCredits: number | undefined;
  if (caseRecord.partnerId) {
    const partner = meterPartnerAiTokens(store, caseRecord.id, venice.tokensUsed);
    balanceCredits = partner?.balanceCredits;
  } else {
    const account = debitCreditsForTokens(store, input.walletAddress!, venice.tokensUsed, {
      caseId: caseRecord.id,
      kind: "token"
    });
    balanceCredits = account.balanceCredits;
  }
  const timeline = createTimelineEvent(caseRecord.id, "Venice", "Agent reply", venice.reply);
  store.agentTimeline.set(timeline.id, timeline);
  return { reply: venice.reply, timeline, balanceCredits };
}

export async function meterVeniceAnalysis(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    kind: VeniceAnalysisKind;
    walletAddress?: string;
    notes?: string;
    destination?: string;
    actionType?: ActionType;
  }
) {
  if (!isVeniceConfigured()) {
    throw new HttpError(503, "venice-not-configured", {
      message: "Set VENICE_API_KEY to enable Venice.ai."
    });
  }
  let maxTokens = 1200;
  if (caseRecord.partnerId) {
    assertPartnerAiBudget(store, caseRecord.id);
  } else {
    if (!input.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    let entitlement;
    try {
      entitlement = assertAiBudget(store, input.walletAddress, "analysis");
    } catch (error) {
      const err = error as Error & { statusCode?: number; code?: string };
      if (err.statusCode === 402) {
        throw new HttpError(402, err.code || "credits-insufficient", {
          products: X402_PRODUCTS,
          credits: resolveCreditsView(store, input.walletAddress),
          config: x402PublicConfig()
        });
      }
      throw error;
    }
    maxTokens = maxTokensForEntitlement(entitlement);
  }
  const analysis = await runVeniceAnalysis({
    caseId: caseRecord.id,
    kind: input.kind,
    notes: input.notes,
    destination: input.destination,
    actionType: input.actionType,
    maxTokens
  });
  const { tokensUsed, ...stored } = analysis;
  store.veniceAnalyses.set(stored.id, stored);
  let balanceCredits: number | undefined;
  if (caseRecord.partnerId) {
    const partner = meterPartnerAiTokens(store, caseRecord.id, tokensUsed);
    balanceCredits = partner?.balanceCredits;
  } else {
    const account = debitCreditsForTokens(store, input.walletAddress!, tokensUsed, {
      caseId: caseRecord.id,
      kind: "token"
    });
    balanceCredits = account.balanceCredits;
  }
  const timeline = createTimelineEvent(caseRecord.id, "Venice", stored.output.title, stored.output.summary);
  store.agentTimeline.set(timeline.id, timeline);
  return { analysis: stored, timeline, balanceCredits };
}