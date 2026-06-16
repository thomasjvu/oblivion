import { assertAiBudget, maxTokensForEntitlement } from "../../domain/aiBudget.js";
import { debitCreditsForTokens, resolveCreditsView } from "../../domain/credits.js";
import { createTimelineEvent } from "../../domain/agentTimeline.js";
import {
  VENICE_DEFAULT_MAX_TOKENS_ANALYSIS,
  VENICE_DEFAULT_MAX_TOKENS_CHAT,
  isEvmAddress
} from "../../domain/constants.js";
import { X402_PRODUCTS } from "../../domain/payments/catalog.js";
import { assertPartnerAiBudget, meterPartnerAiTokens } from "../../domain/partnerBilling.js";
import type { ActionType, CaseRecord, VeniceAnalysisKind } from "../../domain/types.js";
import { isVeniceConfigured, runVeniceAgentReply, runVeniceAnalysis } from "../../domain/venice.js";
import { x402PublicConfig } from "../../domain/x402.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { HttpError } from "../errors.js";

type VeniceMeterKind = "chat" | "analysis";

async function meterVeniceCall(
  store: MemoryStore,
  caseRecord: CaseRecord,
  kind: VeniceMeterKind,
  input: {
    walletAddress?: string;
    message?: string;
    analysis?: {
      kind: VeniceAnalysisKind;
      notes?: string;
      destination?: string;
      actionType?: ActionType;
    };
  }
) {
  if (!isVeniceConfigured()) {
    throw new HttpError(503, "venice-not-configured", {
      message: kind === "chat" ? "Set VENICE_API_KEY to enable the live agent." : "Set VENICE_API_KEY to enable Venice.ai."
    });
  }

  const defaultMaxTokens = kind === "chat" ? VENICE_DEFAULT_MAX_TOKENS_CHAT : VENICE_DEFAULT_MAX_TOKENS_ANALYSIS;
  const budgetKind = kind;
  let maxTokens = defaultMaxTokens;

  if (caseRecord.partnerId) {
    assertPartnerAiBudget(store, caseRecord.id);
  } else {
    if (!isEvmAddress(input.walletAddress)) throw new HttpError(422, "wallet-address-required");
    try {
      const entitlement = assertAiBudget(store, input.walletAddress, budgetKind);
      maxTokens = maxTokensForEntitlement(entitlement);
    } catch (error) {
      const err = error as Error & { statusCode?: number; code?: string };
      if (err.statusCode === 402) {
        throw new HttpError(402, err.code || "credits-insufficient", {
          products: X402_PRODUCTS,
          credits: resolveCreditsView(store, input.walletAddress!),
          config: x402PublicConfig()
        });
      }
      throw error;
    }
  }

  let tokensUsed: number;
  let balanceCredits: number | undefined;
  let timelineTitle: string;
  let timelineSummary: string;

  if (kind === "chat") {
    const plan = store.agentPlanForCase(caseRecord.id);
    const venice = await runVeniceAgentReply({
      caseId: caseRecord.id,
      message: input.message!,
      planStep: plan?.currentStep,
      presetId: plan?.presetId,
      maxTokens
    });
    tokensUsed = venice.tokensUsed;
    timelineTitle = "Agent reply";
    timelineSummary = venice.reply;
    if (caseRecord.partnerId) {
      balanceCredits = meterPartnerAiTokens(store, caseRecord.id, tokensUsed)?.balanceCredits;
    } else {
      balanceCredits = debitCreditsForTokens(store, input.walletAddress!, tokensUsed, {
        caseId: caseRecord.id,
        kind: "token"
      }).balanceCredits;
    }
    const timeline = createTimelineEvent(caseRecord.id, "Venice", timelineTitle, timelineSummary);
    store.agentTimeline.set(timeline.id, timeline);
    return { reply: venice.reply, timeline, balanceCredits };
  }

  const analysis = await runVeniceAnalysis({
    caseId: caseRecord.id,
    kind: input.analysis!.kind,
    notes: input.analysis!.notes,
    destination: input.analysis!.destination,
    actionType: input.analysis!.actionType,
    maxTokens
  });
  tokensUsed = analysis.tokensUsed;
  const { tokensUsed: _tokensUsed, ...stored } = analysis;
  store.veniceAnalyses.set(stored.id, stored);
  timelineTitle = stored.output.title;
  timelineSummary = stored.output.summary;
  if (caseRecord.partnerId) {
    balanceCredits = meterPartnerAiTokens(store, caseRecord.id, tokensUsed)?.balanceCredits;
  } else {
    balanceCredits = debitCreditsForTokens(store, input.walletAddress!, tokensUsed, {
      caseId: caseRecord.id,
      kind: "token"
    }).balanceCredits;
  }
  const timeline = createTimelineEvent(caseRecord.id, "Venice", timelineTitle, timelineSummary);
  store.agentTimeline.set(timeline.id, timeline);
  return { analysis: stored, timeline, balanceCredits };
}

export async function meterVeniceChat(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: { message: string; walletAddress?: string }
) {
  return meterVeniceCall(store, caseRecord, "chat", input);
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
  return meterVeniceCall(store, caseRecord, "analysis", {
    walletAddress: input.walletAddress,
    analysis: {
      kind: input.kind,
      notes: input.notes,
      destination: input.destination,
      actionType: input.actionType
    }
  });
}