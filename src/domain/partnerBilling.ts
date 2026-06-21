import { DomainError } from "./errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { PartnerMeterKind, PartnerRecord, PartnerUsageEntry } from "./types.js";

export const PARTNER_METER_RATES: Record<PartnerMeterKind, number> = {
  case: Number(process.env.OBLIVION_PARTNER_RATE_CASE || "10"),
  discover: Number(process.env.OBLIVION_PARTNER_RATE_DISCOVER || "5"),
  execute: Number(process.env.OBLIVION_PARTNER_RATE_EXECUTE || "15"),
  ai: Number(process.env.OBLIVION_PARTNER_RATE_AI || "2"),
  recheck: Number(process.env.OBLIVION_PARTNER_RATE_RECHECK || "1")
};

export function partnerBillingView(partner: PartnerRecord) {
  return {
    partnerId: partner.id,
    balanceCredits: partner.balanceCredits,
    rates: PARTNER_METER_RATES,
    invoicesPath: "/v1/billing/invoices"
  };
}

export function creditPartnerPool(
  store: MemoryStore,
  partner: PartnerRecord,
  credits: number
): PartnerRecord {
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new DomainError("invalid-credit-amount", 422);
  }
  partner.balanceCredits += credits;
  partner.updatedAt = new Date().toISOString();
  store.partners.set(partner.id, partner);
  return partner;
}

export function partnerAiCreditsForTokens(tokensUsed: number): number {
  const per100 = PARTNER_METER_RATES.ai;
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return per100;
  return Math.max(per100, Math.ceil(tokensUsed / 100) * per100);
}

export function meterPartnerCredits(
  store: MemoryStore,
  partner: PartnerRecord,
  credits: number,
  kind: PartnerMeterKind,
  caseId?: string
): PartnerRecord {
  if (!Number.isFinite(credits) || credits <= 0) return partner;
  if (partner.balanceCredits < credits) {
    throw new DomainError("partner-credits-insufficient", 402);
  }
  partner.balanceCredits -= credits;
  partner.updatedAt = new Date().toISOString();
  store.partners.set(partner.id, partner);
  const entry: PartnerUsageEntry = {
    id: `usage_${crypto.randomUUID()}`,
    partnerId: partner.id,
    caseId,
    kind,
    credits,
    createdAt: new Date().toISOString()
  };
  store.partnerUsage.set(entry.id, entry);
  return partner;
}

export function meterPartnerUsage(
  store: MemoryStore,
  partner: PartnerRecord,
  kind: PartnerMeterKind,
  caseId?: string
): PartnerRecord {
  return meterPartnerCredits(store, partner, PARTNER_METER_RATES[kind], kind, caseId);
}

export function assertPartnerAiBudget(store: MemoryStore, caseId: string, tokensEstimate = 100): void {
  const caseRecord = store.cases.get(caseId);
  if (!caseRecord?.partnerId) return;
  const partner = store.partners.get(caseRecord.partnerId);
  if (!partner) return;
  const required = partnerAiCreditsForTokens(tokensEstimate);
  if (partner.balanceCredits < required) {
    throw new DomainError("partner-credits-insufficient", 402);
  }
}

export function meterPartnerAiTokens(
  store: MemoryStore,
  caseId: string,
  tokensUsed: number
): PartnerRecord | undefined {
  const caseRecord = store.cases.get(caseId);
  if (!caseRecord?.partnerId) return undefined;
  const partner = store.partners.get(caseRecord.partnerId);
  if (!partner) return undefined;
  return meterPartnerCredits(store, partner, partnerAiCreditsForTokens(tokensUsed), "ai", caseId);
}

export function partnerUsageSummary(store: MemoryStore, partnerId: string) {
  const entries = [...store.partnerUsage.values()].filter((entry) => entry.partnerId === partnerId);
  const cases = [...store.cases.values()].filter(
    (caseRecord) => caseRecord.partnerId === partnerId && !caseRecord.deletedAt
  );
  const byKind = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] ?? 0) + entry.credits;
    return acc;
  }, {});
  return {
    partnerId,
    activeCases: cases.length,
    creditsConsumed: entries.reduce((sum, entry) => sum + entry.credits, 0),
    byKind,
    recent: entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((entry) => ({
        kind: entry.kind,
        caseId: entry.caseId,
        credits: entry.credits,
        createdAt: entry.createdAt
      }))
  };
}