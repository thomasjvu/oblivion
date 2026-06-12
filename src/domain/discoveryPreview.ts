import type { MemoryStore } from "../storage/memoryStore.js";
import {
  brokerCatalogEntryById,
  brokerForUrl,
  buildBrokerSweepQueries,
  previewBrokerSweepLimit
} from "./brokerCatalog.js";
import {
  compareMatchScores,
  isJunkDiscoveryUrl,
  scoreDiscoveryCandidate,
  type DiscoveryMatchScore
} from "./discoveryHeuristics.js";
import {
  buildBraveSearchQuery,
  fetchBrokerSweepCandidates,
  fetchWebSearchCandidates,
  type DiscoveryCandidate
} from "./exposureDiscovery.js";
import { redactText } from "./redaction.js";
import type { RedactedScope } from "./types.js";
import { walletKeyFromAddress } from "./credits.js";

export function previewDailyLimit(): number {
  const raw = Number(process.env.OBLIVION_PREVIEW_DAILY_LIMIT ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), 20);
}

export function previewQuotaEnabled(): boolean {
  return previewDailyLimit() > 0;
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

export function previewUsageRemaining(
  store: MemoryStore,
  ip: string,
  walletAddress?: string
): number | null {
  const limit = previewDailyLimit();
  if (!limit) return null;
  const key = usageKey(ip, walletAddress);
  const entry = store.discoveryPreviewUsage.get(key);
  const today = usageDay();
  if (!entry || entry.day !== today) return limit;
  return Math.max(0, limit - entry.count);
}

export function assertPreviewQuota(store: MemoryStore, ip: string, walletAddress?: string): void {
  if (!previewQuotaEnabled()) return;
  const remaining = previewUsageRemaining(store, ip, walletAddress);
  if (remaining !== null && remaining <= 0) {
    throw Object.assign(new Error("preview-quota-exceeded"), {
      statusCode: 429,
      code: "preview-quota-exceeded",
      limit: previewDailyLimit()
    });
  }
}

export function recordPreviewUsage(
  store: MemoryStore,
  ip: string,
  walletAddress?: string
): number | null {
  if (!previewQuotaEnabled()) return null;
  const limit = previewDailyLimit();
  const key = usageKey(ip, walletAddress);
  const today = usageDay();
  const entry = store.discoveryPreviewUsage.get(key);
  const count = entry?.day === today ? entry.count + 1 : 1;
  store.discoveryPreviewUsage.set(key, { day: today, count });
  return Math.max(0, limit - count);
}

export function previewResultLimit(): number {
  const raw = Number(process.env.OBLIVION_PREVIEW_RESULT_LIMIT ?? "48");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 48;
}

export function previewSearchConcurrency(): number {
  const raw = Number(process.env.OBLIVION_PREVIEW_SEARCH_CONCURRENCY ?? "4");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 8) : 4;
}

export interface DiscoveryPreviewCandidate {
  sourceUrl: string;
  brokerId?: string;
  brokerLabel?: string;
  title?: string;
  snippet?: string;
  matchScore: DiscoveryMatchScore;
  matchReason: string;
}

export interface DiscoveryPreviewStats {
  brokersChecked: number;
  queriesRun: number;
  sweepHits: number;
  broadSearchHits: number;
  searchErrors: number;
}

function uniqueBrokerIds(queries: Array<{ brokerId: string }>): number {
  return new Set(queries.map((item) => item.brokerId)).size;
}

function addCandidate(
  seen: Set<string>,
  candidates: DiscoveryCandidate[],
  item: DiscoveryCandidate
): boolean {
  if (isJunkDiscoveryUrl(item.sourceUrl)) return false;
  if (seen.has(item.sourceUrl)) return false;
  seen.add(item.sourceUrl);
  candidates.push(item);
  return true;
}

export async function runDiscoveryPreview(input: {
  personLabel: string;
  aliases?: string[];
  regionLabel?: string;
  sweepLimit?: number;
}): Promise<{ candidates: DiscoveryPreviewCandidate[]; stats: DiscoveryPreviewStats }> {
  const scope: RedactedScope = {
    personLabel: redactText(input.personLabel.trim() || "Unknown"),
    aliases: (input.aliases ?? []).map((item) => redactText(item.trim())).filter(Boolean),
    approvedIdentifierLabels: input.regionLabel?.trim() ? [redactText(input.regionLabel.trim())] : [],
    sensitiveConstraints: []
  };
  if (!scope.personLabel || scope.personLabel === "Unknown") {
    throw Object.assign(new Error("person-label-required"), { statusCode: 422 });
  }

  const sweepScope = {
    personLabel: input.personLabel.trim(),
    aliases: input.aliases,
    regionLabel: input.regionLabel
  };
  const queries = buildBrokerSweepQueries(sweepScope, {
    limit: input.sweepLimit ?? previewBrokerSweepLimit(),
    preview: true
  });
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];
  let sweepHits = 0;
  let searchErrors = 0;

  const sweep = await fetchBrokerSweepCandidates(sweepScope, {
    limit: input.sweepLimit ?? previewBrokerSweepLimit(),
    preview: true,
    concurrency: previewSearchConcurrency()
  });
  searchErrors += sweep.searchErrors;
  for (const result of sweep.candidates) {
    if (addCandidate(seen, candidates, result)) sweepHits += 1;
  }

  let broadSearchHits = 0;
  try {
    const broadQuery = buildBraveSearchQuery(scope);
    const broadResults = await fetchWebSearchCandidates(broadQuery);
    for (const result of broadResults) {
      const broker = brokerForUrl(result.sourceUrl);
      if (!broker) continue;
      if (addCandidate(seen, candidates, { ...result, origin: "brave-search", brokerId: broker.brokerId })) {
        broadSearchHits += 1;
      }
    }
  } catch {
    searchErrors += 1;
  }

  const scored = candidates
    .map((candidate) => {
      const broker = candidate.brokerId
        ? brokerCatalogEntryById(candidate.brokerId)
        : brokerForUrl(candidate.sourceUrl);
      const scoredCandidate = scoreDiscoveryCandidate(candidate, scope);
      return {
        sourceUrl: candidate.sourceUrl,
        brokerId: broker?.brokerId ?? candidate.brokerId,
        brokerLabel: broker?.brokerLabel,
        title: candidate.title,
        snippet: candidate.snippet,
        matchScore: scoredCandidate.matchScore,
        matchReason: scoredCandidate.matchReason
      } satisfies DiscoveryPreviewCandidate;
    })
    .filter((item) => item.matchScore !== "unlikely")
    .sort((left, right) => compareMatchScores(left.matchScore, right.matchScore))
    .slice(0, previewResultLimit());

  return {
    candidates: scored,
    stats: {
      brokersChecked: uniqueBrokerIds(queries),
      queriesRun: queries.length + 1,
      sweepHits,
      broadSearchHits,
      searchErrors
    }
  };
}