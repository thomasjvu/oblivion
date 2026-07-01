import { DomainError } from "./errors.js";
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
import { deploymentEnvironment } from "./deploymentEnv.js";
import { detectForbiddenSecrets, redactText } from "./redaction.js";
import type { RedactedScope } from "./types.js";
import { walletKeyFromAddress } from "./credits.js";

const PRODUCTION_PREVIEW_DAILY_LIMIT = 5;

export function previewDailyLimit(): number {
  const envRaw = process.env.OBLIVION_PREVIEW_DAILY_LIMIT;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const configured = Number(envRaw);
    if (!Number.isFinite(configured) || configured <= 0) return 0;
    return Math.min(Math.floor(configured), 20);
  }
  if (deploymentEnvironment() === "production") {
    return PRODUCTION_PREVIEW_DAILY_LIMIT;
  }
  return 0;
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
    throw new DomainError("preview-quota-exceeded", 429, {
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
  const raw = Number(process.env.OBLIVION_PREVIEW_RESULT_LIMIT ?? "12");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 12;
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
  confidencePercent: number;
}

export interface DiscoveryPreviewStats {
  brokersChecked: number;
  brokersQueried: string[];
  queriesRun: number;
  sweepHits: number;
  broadSearchHits: number;
  searchErrors: number;
  rawHits: number;
  candidatesShown: number;
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

export function dedupePreviewCandidatesByBroker(
  candidates: DiscoveryPreviewCandidate[]
): DiscoveryPreviewCandidate[] {
  const seenBrokers = new Set<string>();
  const deduped: DiscoveryPreviewCandidate[] = [];
  for (const candidate of candidates) {
    const brokerKey = candidate.brokerId || candidate.brokerLabel || candidate.sourceUrl;
    if (seenBrokers.has(brokerKey)) continue;
    seenBrokers.add(brokerKey);
    deduped.push(candidate);
  }
  return deduped;
}

export async function runDiscoveryPreview(input: {
  personLabel: string;
  aliases?: string[];
  regionLabel?: string;
  sweepLimit?: number;
}): Promise<{ candidates: DiscoveryPreviewCandidate[]; stats: DiscoveryPreviewStats }> {
  const regionForScope = input.regionLabel?.trim() ? redactText(input.regionLabel.trim()) : undefined;
  const scope: RedactedScope = {
    personLabel: redactText(input.personLabel.trim() || "Unknown"),
    aliases: (input.aliases ?? []).map((item) => redactText(item.trim())).filter(Boolean),
    approvedIdentifierLabels: regionForScope ? [regionForScope] : [],
    sensitiveConstraints: regionForScope ? [regionForScope] : []
  };
  if (!scope.personLabel || scope.personLabel === "Unknown") {
    throw new DomainError("person-label-required", 422);
  }

  const personLabel = redactText(input.personLabel.trim());
  if (detectForbiddenSecrets(personLabel).length > 0) {
    throw new DomainError("person-label-forbidden", 422);
  }
  const sweepScope = {
    personLabel,
    aliases: (input.aliases ?? []).map((item) => redactText(item.trim())).filter(Boolean),
    regionLabel: input.regionLabel?.trim() ? redactText(input.regionLabel.trim()) : undefined
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
    const broadQuery = buildBraveSearchQuery(scope, {
      personLabel,
      aliases: sweepScope.aliases,
      regionLabel: sweepScope.regionLabel
    });
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

  const rawHits = sweepHits + broadSearchHits;
  const scored = dedupePreviewCandidatesByBroker(
    candidates
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
          matchReason: scoredCandidate.matchReason,
          confidencePercent: scoredCandidate.confidencePercent
        } satisfies DiscoveryPreviewCandidate;
      })
      .filter((item) => item.matchScore === "likely")
      .sort(
        (left, right) =>
          right.confidencePercent - left.confidencePercent ||
          compareMatchScores(left.matchScore, right.matchScore)
      )
      .slice(0, previewResultLimit())
  );

  const brokersQueried = [
    ...new Set(
      queries
        .map((item) => brokerCatalogEntryById(item.brokerId)?.brokerLabel ?? item.brokerId)
        .filter(Boolean)
    )
  ];

  return {
    candidates: scored,
    stats: {
      brokersChecked: uniqueBrokerIds(queries),
      brokersQueried,
      queriesRun: queries.length + 1,
      sweepHits,
      broadSearchHits,
      searchErrors,
      rawHits,
      candidatesShown: scored.length
    }
  };
}