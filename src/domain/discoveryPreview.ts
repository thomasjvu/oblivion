import type { MemoryStore } from "../storage/memoryStore.js";
import { redactText } from "./redaction.js";
import {
  brokerCatalogEntryById,
  brokerForUrl,
  buildBrokerSweepQueries,
  previewBrokerSweepLimit
} from "./brokerCatalog.js";
import { fetchWebSearchCandidates, type DiscoveryCandidate } from "./exposureDiscovery.js";
import type { RedactedScope } from "./types.js";
import { walletKeyFromAddress } from "./credits.js";

export function previewDailyLimit(): number {
  const raw = Number(process.env.OBLIVION_PREVIEW_DAILY_LIMIT || "3");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20) : 3;
}

function usageDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(ip: string, walletAddress?: string): string {
  if (walletAddress?.startsWith("0x")) {
    return `wallet:${walletKeyFromAddress(walletAddress)}`;
  }
  return `ip:${ip || "unknown"}`;
}

export function previewUsageRemaining(store: MemoryStore, ip: string, walletAddress?: string): number {
  const key = usageKey(ip, walletAddress);
  const entry = store.discoveryPreviewUsage.get(key);
  const today = usageDay();
  if (!entry || entry.day !== today) return previewDailyLimit();
  return Math.max(0, previewDailyLimit() - entry.count);
}

export function assertPreviewQuota(store: MemoryStore, ip: string, walletAddress?: string): void {
  if (previewUsageRemaining(store, ip, walletAddress) <= 0) {
    throw Object.assign(new Error("preview-quota-exceeded"), {
      statusCode: 429,
      code: "preview-quota-exceeded",
      limit: previewDailyLimit()
    });
  }
}

export function recordPreviewUsage(store: MemoryStore, ip: string, walletAddress?: string): number {
  const key = usageKey(ip, walletAddress);
  const today = usageDay();
  const entry = store.discoveryPreviewUsage.get(key);
  const count = entry?.day === today ? entry.count + 1 : 1;
  store.discoveryPreviewUsage.set(key, { day: today, count });
  return Math.max(0, previewDailyLimit() - count);
}

function heuristicPreviewScore(candidate: DiscoveryCandidate, scope: RedactedScope): "likely" | "uncertain" | "unlikely" {
  const haystack = `${candidate.sourceUrl} ${candidate.title ?? ""} ${candidate.snippet ?? ""}`.toLowerCase();
  const needles = [scope.personLabel, ...(scope.aliases ?? [])]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item && item.length > 2));
  const brokerHit = Boolean(brokerForUrl(candidate.sourceUrl));
  const nameHit = needles.some((needle) => haystack.includes(needle.replace(/\s+/g, "-")) || haystack.includes(needle));
  if (nameHit && brokerHit) return "likely";
  if (brokerHit || nameHit) return "uncertain";
  return "unlikely";
}

export async function runDiscoveryPreview(input: {
  personLabel: string;
  aliases?: string[];
  regionLabel?: string;
  sweepLimit?: number;
}): Promise<
  Array<{
    sourceUrl: string;
    brokerId?: string;
    brokerLabel?: string;
    title?: string;
    snippet?: string;
    matchScore: "likely" | "uncertain" | "unlikely";
  }>
> {
  const scope: RedactedScope = {
    personLabel: redactText(input.personLabel.trim() || "Unknown"),
    aliases: (input.aliases ?? []).map((item) => redactText(item.trim())).filter(Boolean),
    approvedIdentifierLabels: input.regionLabel?.trim() ? [redactText(input.regionLabel.trim())] : [],
    sensitiveConstraints: []
  };
  if (!scope.personLabel || scope.personLabel === "Unknown") {
    throw Object.assign(new Error("person-label-required"), { statusCode: 422 });
  }

  const limit = input.sweepLimit ?? previewBrokerSweepLimit();
  const queries = buildBrokerSweepQueries(scope, { limit, preview: true });
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];

  for (const item of queries) {
    try {
      const results = await fetchWebSearchCandidates(item.query);
      for (const result of results) {
        const broker = brokerForUrl(result.sourceUrl);
        if (broker?.brokerId !== item.brokerId) continue;
        if (seen.has(result.sourceUrl)) continue;
        seen.add(result.sourceUrl);
        candidates.push({ ...result, origin: "broker-sweep", brokerId: item.brokerId });
      }
    } catch {
      continue;
    }
  }

  return candidates.slice(0, 12).map((candidate) => {
    const broker = candidate.brokerId ? brokerCatalogEntryById(candidate.brokerId) : brokerForUrl(candidate.sourceUrl);
    return {
      sourceUrl: candidate.sourceUrl,
      brokerId: broker?.brokerId ?? candidate.brokerId,
      brokerLabel: broker?.brokerLabel,
      title: candidate.title,
      snippet: candidate.snippet,
      matchScore: heuristicPreviewScore(candidate, scope)
    };
  });
}