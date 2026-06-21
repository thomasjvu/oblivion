import { DomainError } from "./errors.js";
import {
  BROKER_HOST_HINT,
  brokerCatalogEntryById,
  brokerForUrl,
  buildBrokerSweepQueries,
  type BrokerCatalogEntry
} from "./brokerCatalog.js";
import { mapWithConcurrency } from "./asyncUtil.js";
import { redactText } from "./redaction.js";
import {
  braveSearchBaseUrl,
  braveSearchCount,
  isBraveSearchConfigured,
  isDiscoverySearchConfigured,
  isVeniceSearchConfigured
} from "./integrations.js";
import type {
  Exposure,
  ExposureMatchScore,
  ExposureMatchStatus,
  RedactedScope
} from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { assertPartnerAiBudget, meterPartnerAiTokens } from "./partnerBilling.js";
import { discoveryCredits } from "./credits.js";
import { veniceChatCompletion, isVeniceConfigured, veniceWebSearch } from "./venice.js";
import { isJunkDiscoveryUrl, scoreDiscoveryCandidate } from "./discoveryHeuristics.js";

export type { BrokerCatalogEntry };

function discoverySearchConcurrency(): number {
  const raw = Number(
    process.env.OBLIVION_DISCOVERY_SEARCH_CONCURRENCY ??
      process.env.OBLIVION_PREVIEW_SEARCH_CONCURRENCY ??
      "4"
  );
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 8) : 4;
}
export { brokerForUrl, brokerCatalogEntryById, BROKER_HOST_HINT };

export interface DiscoveryCandidate {
  sourceUrl: string;
  title?: string;
  snippet?: string;
  origin: "pasted" | "brave-search" | "venice-search" | "broker-sweep";
  brokerId?: string;
}

export function normalizeDiscoveryUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildBraveSearchQuery(scope: RedactedScope | undefined): string {
  const parts = [scope?.personLabel, ...(scope?.aliases ?? []), ...(scope?.approvedIdentifierLabels ?? [])]
    .map((item) => item?.trim())
    .filter(Boolean);
  const base = parts.length ? parts.join(" ") : "people search profile";
  return redactText(`${base} people search background check listing`);
}

function discoverySearchLimit(): number {
  return Math.min(braveSearchCount(), 20);
}

function candidatesFromSearchResults(
  results: Array<{ url: string; title?: string; snippet?: string }>,
  origin: "brave-search" | "venice-search"
): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];
  for (const item of results) {
    const sourceUrl = normalizeDiscoveryUrl(item.url);
    if (!sourceUrl) continue;
    const broker = brokerForUrl(sourceUrl);
    candidates.push({
      sourceUrl,
      title: item.title ? redactText(item.title) : undefined,
      snippet: item.snippet ? redactText(item.snippet) : undefined,
      origin,
      brokerId: broker?.brokerId
    });
  }
  return candidates;
}

export async function fetchVeniceSearchCandidates(query: string): Promise<DiscoveryCandidate[]> {
  if (!isVeniceSearchConfigured()) return [];
  const results = await veniceWebSearch(query, { limit: discoverySearchLimit(), searchProvider: "brave" });
  return candidatesFromSearchResults(
    results.map((item) => ({ url: item.url, title: item.title, snippet: item.content })),
    "venice-search"
  );
}

export async function fetchBraveSearchCandidates(query: string): Promise<DiscoveryCandidate[]> {
  if (!isBraveSearchConfigured()) return [];
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL(braveSearchBaseUrl());
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(braveSearchCount()));
  url.searchParams.set("country", process.env.BRAVE_SEARCH_COUNTRY?.trim() || "US");
  url.searchParams.set("search_lang", process.env.BRAVE_SEARCH_LANG?.trim() || "en");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });
  if (!response.ok) {
    throw new DomainError(`brave-search-${response.status}`, 502);
  }
  const json = (await response.json()) as {
    web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
  };
  const results = json.web?.results ?? [];
  return candidatesFromSearchResults(
    results
      .map((item) => ({
        url: item.url ?? "",
        title: item.title,
        snippet: item.description
      }))
      .filter((item) => item.url),
    "brave-search"
  );
}

export async function fetchWebSearchCandidates(query: string): Promise<DiscoveryCandidate[]> {
  if (isBraveSearchConfigured()) {
    try {
      return await fetchBraveSearchCandidates(query);
    } catch (error) {
      if (isVeniceSearchConfigured()) {
        return fetchVeniceSearchCandidates(query);
      }
      throw error;
    }
  }
  if (isVeniceSearchConfigured()) {
    return fetchVeniceSearchCandidates(query);
  }
  return [];
}

type BrokerSweepScope = { personLabel?: string; aliases?: string[]; regionLabel?: string } | undefined;

export async function fetchBrokerSweepCandidates(
  scope: BrokerSweepScope,
  options: { limit?: number; preview?: boolean; concurrency?: number } = {}
): Promise<{ candidates: DiscoveryCandidate[]; searchErrors: number }> {
  if (!isDiscoverySearchConfigured()) return { candidates: [], searchErrors: 0 };
  const queries = buildBrokerSweepQueries(scope, { limit: options.limit, preview: options.preview });
  const collectHits = async (item: (typeof queries)[number]) => {
    const hits: DiscoveryCandidate[] = [];
    try {
      const results = await fetchWebSearchCandidates(item.query);
      for (const result of results) {
        const broker = brokerForUrl(result.sourceUrl);
        if (broker?.brokerId === item.brokerId) {
          hits.push({ ...result, origin: "broker-sweep", brokerId: item.brokerId });
        }
      }
      return { ok: true as const, hits };
    } catch {
      return { ok: false as const, hits: [] };
    }
  };
  if (options.concurrency && options.concurrency > 1) {
    const batches = await mapWithConcurrency(queries, options.concurrency, collectHits);
    let searchErrors = 0;
    const candidates: DiscoveryCandidate[] = [];
    for (const batch of batches) {
      if (!batch.ok) searchErrors += 1;
      candidates.push(...batch.hits);
    }
    return { candidates, searchErrors };
  }
  const candidates: DiscoveryCandidate[] = [];
  let searchErrors = 0;
  for (const item of queries) {
    const batch = await collectHits(item);
    if (!batch.ok) searchErrors += 1;
    candidates.push(...batch.hits);
  }
  return { candidates, searchErrors };
}

function heuristicMatchScore(candidate: DiscoveryCandidate, scope: RedactedScope | undefined): ExposureMatchScore {
  if (!scope) return "unlikely";
  if (isJunkDiscoveryUrl(candidate.sourceUrl)) return "unlikely";
  return scoreDiscoveryCandidate(candidate, scope).matchScore;
}

function scoreCandidateHeuristic(
  candidate: DiscoveryCandidate,
  scope: RedactedScope | undefined
): { matchScore: ExposureMatchScore; matchReason: string; tokensUsed: number } {
  return {
    matchScore: heuristicMatchScore(candidate, scope),
    matchReason: "Heuristic match from redacted labels and broker host.",
    tokensUsed: 0
  };
}

async function scoreWithVenice(
  candidate: DiscoveryCandidate,
  scope: RedactedScope | undefined
): Promise<{ matchScore: ExposureMatchScore; matchReason: string; tokensUsed: number }> {
  const fallback = heuristicMatchScore(candidate, scope);
  if (!isVeniceConfigured()) {
    return scoreCandidateHeuristic(candidate, scope);
  }
  const scopeSummary = redactText(
    [
      scope?.personLabel ? `personLabel: ${scope.personLabel}` : "",
      scope?.aliases?.length ? `aliases: ${scope.aliases.join(", ")}` : "",
      scope?.approvedIdentifierLabels?.length
        ? `labels: ${scope.approvedIdentifierLabels.join(", ")}`
        : ""
    ]
      .filter(Boolean)
      .join("; ")
  );
  const { content, tokensUsed } = await veniceChatCompletion([
    {
      role: "system",
      content: [
        "Score whether a search result likely belongs to the subject described by redacted labels only.",
        "Never request or infer raw phone, email, SSN, or street address.",
        'Respond JSON only: {"matchScore":"likely|uncertain|unlikely","matchReason":"short reason"}'
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Redacted scope: ${scopeSummary || "unknown"}`,
        `Candidate URL: ${redactText(candidate.sourceUrl)}`,
        `Title: ${redactText(candidate.title || "n/a")}`,
        `Snippet: ${redactText(candidate.snippet || "n/a")}`,
        "Mark unlikely if name/location clearly refers to a different person."
      ].join("\n")
    }
  ]);
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    const parsed = JSON.parse(content.slice(start, end + 1)) as { matchScore?: string; matchReason?: string };
    const score = parsed.matchScore;
    const matchScore: ExposureMatchScore =
      score === "likely" || score === "uncertain" || score === "unlikely" ? score : fallback;
    return {
      matchScore,
      matchReason: redactText(parsed.matchReason || "Venice scored the candidate."),
      tokensUsed
    };
  } catch {
    return {
      matchScore: fallback,
      matchReason: "Venice parse failed; heuristic score used.",
      tokensUsed
    };
  }
}

async function scoreCandidate(
  candidate: DiscoveryCandidate,
  scope: RedactedScope | undefined,
  options: { veniceEnabled: boolean }
): Promise<{ matchScore: ExposureMatchScore; matchReason: string; tokensUsed: number }> {
  if (!options.veniceEnabled) {
    return scoreCandidateHeuristic(candidate, scope);
  }
  try {
    return await scoreWithVenice(candidate, scope);
  } catch {
    return scoreCandidateHeuristic(candidate, scope);
  }
}

function discoverySearchProviderLabel(): string {
  if (isBraveSearchConfigured() && isVeniceSearchConfigured()) {
    return "Brave search (Venice fallback)";
  }
  if (isBraveSearchConfigured()) return "Brave search";
  if (isVeniceSearchConfigured()) return "Venice web search (Brave ZDR)";
  return "Web search";
}

export function confidenceFromMatchScore(score: ExposureMatchScore): Exposure["confidence"] {
  if (score === "likely") return "high";
  if (score === "uncertain") return "medium";
  return "low";
}

function exposureFromBroker(
  broker: BrokerCatalogEntry | undefined,
  candidate: DiscoveryCandidate,
  scored: { matchScore: ExposureMatchScore; matchReason: string },
  caseId: string,
  now: string
): Exposure {
  return {
    id: `exposure_${crypto.randomUUID()}`,
    caseId,
    sourceUrl: candidate.sourceUrl,
    visibleDataCategories: ["legal-name", "city-state"],
    confidence: confidenceFromMatchScore(scored.matchScore),
    evidencePointer: `discovery://${candidate.origin}`,
    officialRemovalPath: broker?.officialRemovalPath,
    officialOptOutUrl: broker?.officialOptOutUrl,
    createdAt: now,
    matchStatus: "pending" satisfies ExposureMatchStatus,
    brokerId: broker?.brokerId ?? candidate.brokerId,
    brokerLabel: broker?.brokerLabel,
    redactedSnippet: candidate.snippet || candidate.title,
    matchScore: scored.matchScore,
    matchReason: scored.matchReason,
    removalStatus: "not-started",
    submissionMethod: broker?.submissionMethod,
    teeAutomatable: broker?.teeAutomatable
  };
}

export async function discoverExposureCandidates(input: {
  caseId: string;
  store?: MemoryStore;
  scope?: RedactedScope;
  pastedUrls?: string[];
  existingUrls?: string[];
  contentTakedown?: boolean;
  brokerSweep?: boolean;
}): Promise<Exposure[]> {
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];

  for (const raw of input.pastedUrls ?? []) {
    const sourceUrl = normalizeDiscoveryUrl(raw);
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const broker = brokerForUrl(sourceUrl);
    candidates.push({ sourceUrl, origin: "pasted", brokerId: broker?.brokerId });
  }

  if (isDiscoverySearchConfigured()) {
    try {
      if (input.brokerSweep !== false && !input.contentTakedown) {
        const { candidates: sweepResults } = await fetchBrokerSweepCandidates(input.scope, {
          concurrency: discoverySearchConcurrency()
        });
        for (const item of sweepResults) {
          if (seen.has(item.sourceUrl)) continue;
          seen.add(item.sourceUrl);
          candidates.push(item);
        }
      }
      const query = buildBraveSearchQuery(input.scope);
      const braveResults = await fetchWebSearchCandidates(query);
      for (const item of braveResults) {
        if (seen.has(item.sourceUrl)) continue;
        seen.add(item.sourceUrl);
        candidates.push(item);
      }
    } catch (error) {
      if (!candidates.length) throw error;
    }
  }

  const filtered = candidates.filter((candidate) => {
    if ((input.existingUrls ?? []).includes(candidate.sourceUrl)) return false;
    if (input.contentTakedown) return true;
    const broker = brokerForUrl(candidate.sourceUrl);
    if (broker) return true;
    return BROKER_HOST_HINT.test(`${candidate.sourceUrl} ${candidate.title ?? ""} ${candidate.snippet ?? ""}`);
  });

  const exposures: Exposure[] = [];
  const batch = filtered.slice(0, 25);
  let veniceScoringEnabled = isVeniceConfigured();
  if (input.store && veniceScoringEnabled && batch.length > 0) {
    try {
      assertPartnerAiBudget(input.store, input.caseId, 100 * batch.length);
    } catch (error) {
      if ((error as { message?: string })?.message === "partner-credits-insufficient") {
        veniceScoringEnabled = false;
      } else {
        throw error;
      }
    }
  }
  let veniceTokensUsed = 0;
  for (const candidate of batch) {
    const scored = await scoreCandidate(candidate, input.scope, { veniceEnabled: veniceScoringEnabled });
    veniceTokensUsed += scored.tokensUsed;
    const broker = brokerForUrl(candidate.sourceUrl) ?? (candidate.brokerId ? brokerCatalogEntryById(candidate.brokerId) : undefined);
    exposures.push(exposureFromBroker(broker, candidate, scored, input.caseId, new Date().toISOString()));
  }

  if (input.store && veniceTokensUsed > 0) {
    meterPartnerAiTokens(input.store, input.caseId, veniceTokensUsed);
  }

  return exposures;
}

export function applyFindingDecision(
  exposure: Exposure,
  decision: "confirmed" | "rejected"
): Exposure {
  const now = new Date().toISOString();
  if (decision === "rejected") {
    return {
      ...exposure,
      matchStatus: "rejected",
      matchReason: exposure.matchReason ?? "Marked as not the subject.",
      removalStatus: "not-started"
    };
  }
  const broker = exposure.brokerId
    ? brokerCatalogEntryById(exposure.brokerId)
    : brokerForUrl(exposure.sourceUrl);
  return {
    ...exposure,
    matchStatus: "confirmed",
    confidence: "high",
    brokerId: broker?.brokerId ?? exposure.brokerId,
    brokerLabel: broker?.brokerLabel ?? exposure.brokerLabel,
    officialOptOutUrl: broker?.officialOptOutUrl ?? exposure.officialOptOutUrl,
    officialRemovalPath: broker?.officialRemovalPath ?? exposure.officialRemovalPath,
    submissionMethod: broker?.submissionMethod ?? exposure.submissionMethod,
    teeAutomatable: broker?.teeAutomatable ?? exposure.teeAutomatable,
    removalStatus: exposure.removalStatus === "not-started" ? "drafted" : exposure.removalStatus,
    matchReason: exposure.matchReason ?? "Confirmed by user."
  };
}

export interface DiscoveryPlanMethod {
  id: "pasted-urls" | "broker-sweep" | "web-search" | "match-scoring" | "manual-only";
  label: string;
  detail: string;
  enabled: boolean;
}

export function describeDiscoveryPlan(input: {
  scope?: RedactedScope;
  pastedUrlCount?: number;
  brokerSweep?: boolean;
  contentTakedown?: boolean;
}): { methods: DiscoveryPlanMethod[]; canAutoDiscover: boolean; summary: string } {
  const searchReady = isDiscoverySearchConfigured();
  const veniceSearchReady = isVeniceSearchConfigured();
  const braveDirectReady = isBraveSearchConfigured();
  const veniceReady = isVeniceConfigured();
  const pastedCount = input.pastedUrlCount ?? 0;
  const brokerSweepEnabled =
    input.brokerSweep !== false && !input.contentTakedown && searchReady;
  const searchProviderLabel = discoverySearchProviderLabel();
  const name = input.scope?.personLabel?.trim() || "";
  const methods: DiscoveryPlanMethod[] = [];

  if (pastedCount > 0) {
    methods.push({
      id: "pasted-urls",
      label: "Your pasted links",
      detail: `Import ${pastedCount} URL(s) you provided and match them to known brokers.`,
      enabled: true
    });
  }

  if (brokerSweepEnabled && name) {
    const sweepQueries = buildBrokerSweepQueries(input.scope);
    const hosts = sweepQueries.map((item) => item.host);
    const preview = hosts.slice(0, 4).join(", ");
    const more = hosts.length > 4 ? ` +${hosts.length - 4} more` : "";
    methods.push({
      id: "broker-sweep",
      label: "Broker sweep",
      detail: `Site-scoped ${searchProviderLabel} on ${sweepQueries.length} people-search brokers (${preview}${more}) for “${redactText(name)}”.`,
      enabled: true
    });
  }

  if (searchReady && name && !input.contentTakedown) {
    methods.push({
      id: "web-search",
      label: "Web search",
      detail: `Broader ${searchProviderLabel} query: ${buildBraveSearchQuery(input.scope)}`,
      enabled: true
    });
  }

  if (input.contentTakedown && searchReady && name) {
    methods.push({
      id: "web-search",
      label: "Content search",
      detail: `${searchProviderLabel} query for takedown targets: ${buildBraveSearchQuery(input.scope)}`,
      enabled: true
    });
  }

  if (methods.some((item) => item.id === "broker-sweep" || item.id === "web-search") || pastedCount > 0) {
    methods.push({
      id: "match-scoring",
      label: "Match scoring",
      detail: veniceReady
        ? "Venice ranks each candidate against your redacted name and labels (no vault plaintext)."
        : "Heuristic scoring from redacted name, location labels, and broker host patterns.",
      enabled: true
    });
  }

  if (!searchReady && pastedCount === 0) {
    methods.push({
      id: "manual-only",
      label: "Automated search off",
      detail: veniceSearchReady || braveDirectReady
        ? "Automated search is unavailable — paste profile URLs you already found."
        : "Set BRAVE_SEARCH_API_KEY (preferred) or VENICE_API_KEY, or paste profile URLs you already found.",
      enabled: false
    });
  }

  const canAutoDiscover = searchReady || pastedCount > 0;
  const creditNote =
    brokerSweepEnabled && name ? ` Full broker sweep debits ${discoveryCredits()} wallet credits.` : "";
  const summary = canAutoDiscover
    ? `Discover runs the steps below using only redacted case labels — never raw vault data.${creditNote}`
    : "Paste at least one profile URL below, or enable Venice or Brave search on the server.";

  return { methods, canAutoDiscover, summary };
}

export function discoveryReadinessMessage(): string {
  const parts: string[] = [];
  if (isBraveSearchConfigured() || isVeniceSearchConfigured()) {
    parts.push(`${discoverySearchProviderLabel()} + broker sweep`);
  }
  if (isVeniceConfigured()) parts.push("Venice match scoring");
  if (!parts.length) {
    return "Paste URLs to discover listings (configure BRAVE_SEARCH_API_KEY or VENICE_API_KEY for automated search).";
  }
  return `${parts.join(" + ")} ready. Paste known links or run search.`;
}

