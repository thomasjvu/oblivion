import {
  BROKER_HOST_HINT,
  brokerCatalogEntryById,
  brokerForUrl,
  buildBrokerSweepQueries,
  type BrokerCatalogEntry
} from "./brokerCatalog.js";
import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";
import { braveSearchBaseUrl, braveSearchCount, isBraveSearchConfigured } from "./integrations.js";
import type {
  Exposure,
  ExposureMatchScore,
  ExposureMatchStatus,
  RedactedScope
} from "./types.js";
import { veniceChatCompletion, isVeniceConfigured } from "./venice.js";

export type { BrokerCatalogEntry };
export { brokerForUrl, brokerCatalogEntryById, BROKER_HOST_HINT };

export interface DiscoveryCandidate {
  sourceUrl: string;
  title?: string;
  snippet?: string;
  origin: "pasted" | "brave-search" | "broker-sweep";
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

export async function fetchBraveSearchCandidates(query: string): Promise<DiscoveryCandidate[]> {
  if (!isBraveSearchConfigured()) return [];
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL(braveSearchBaseUrl());
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(braveSearchCount()));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });
  if (!response.ok) {
    throw Object.assign(new Error(`brave-search-${response.status}`), { statusCode: 502 });
  }
  const json = (await response.json()) as {
    web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
  };
  const results = json.web?.results ?? [];
  const candidates: DiscoveryCandidate[] = [];
  for (const item of results) {
    const sourceUrl = item.url ? normalizeDiscoveryUrl(item.url) : null;
    if (!sourceUrl) continue;
    const broker = brokerForUrl(sourceUrl);
    candidates.push({
      sourceUrl,
      title: item.title ? redactText(item.title) : undefined,
      snippet: item.description ? redactText(item.description) : undefined,
      origin: "brave-search",
      brokerId: broker?.brokerId
    });
  }
  return candidates;
}

export async function fetchBrokerSweepCandidates(scope: RedactedScope | undefined): Promise<DiscoveryCandidate[]> {
  if (!isBraveSearchConfigured()) return [];
  const queries = buildBrokerSweepQueries(scope);
  const candidates: DiscoveryCandidate[] = [];
  for (const item of queries) {
    try {
      const results = await fetchBraveSearchCandidates(item.query);
      for (const result of results) {
        const broker = brokerForUrl(result.sourceUrl);
        if (broker?.brokerId === item.brokerId) {
          candidates.push({ ...result, origin: "broker-sweep", brokerId: item.brokerId });
        }
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

function heuristicMatchScore(candidate: DiscoveryCandidate, scope: RedactedScope | undefined): ExposureMatchScore {
  const haystack = `${candidate.sourceUrl} ${candidate.title ?? ""} ${candidate.snippet ?? ""}`.toLowerCase();
  const needles = [scope?.personLabel, ...(scope?.aliases ?? [])]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item && item.length > 2));
  const locationHints = (scope?.approvedIdentifierLabels ?? [])
    .concat(scope?.sensitiveConstraints ?? [])
    .map((item) => item.toLowerCase());
  const nameHit = needles.some((needle) => haystack.includes(needle.replace(/\s+/g, "-")) || haystack.includes(needle));
  const brokerHit = Boolean(brokerForUrl(candidate.sourceUrl)) || BROKER_HOST_HINT.test(haystack);
  const locationHit = locationHints.some(
    (hint) => hint.length > 2 && (haystack.includes(hint) || /massachusetts|\bma\b/.test(haystack))
  );
  if (nameHit && brokerHit) return "likely";
  if (brokerHit && (nameHit || locationHit)) return "uncertain";
  if (brokerHit) return "uncertain";
  return "unlikely";
}

async function scoreWithVenice(
  candidate: DiscoveryCandidate,
  scope: RedactedScope | undefined
): Promise<{ matchScore: ExposureMatchScore; matchReason: string }> {
  const fallback = heuristicMatchScore(candidate, scope);
  if (!isVeniceConfigured()) {
    return {
      matchScore: fallback,
      matchReason: "Heuristic match from redacted labels and broker host."
    };
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
  const content = await veniceChatCompletion([
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
      matchReason: redactText(parsed.matchReason || "Venice scored the candidate.")
    };
  } catch {
    return { matchScore: fallback, matchReason: "Venice parse failed; heuristic score used." };
  }
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

  if (isBraveSearchConfigured()) {
    try {
      if (input.brokerSweep !== false && !input.contentTakedown) {
        const sweepResults = await fetchBrokerSweepCandidates(input.scope);
        for (const item of sweepResults) {
          if (seen.has(item.sourceUrl)) continue;
          seen.add(item.sourceUrl);
          candidates.push(item);
        }
      }
      const query = buildBraveSearchQuery(input.scope);
      const braveResults = await fetchBraveSearchCandidates(query);
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
  for (const candidate of filtered.slice(0, 25)) {
    const scored = await scoreWithVenice(candidate, input.scope);
    const broker = brokerForUrl(candidate.sourceUrl) ?? (candidate.brokerId ? brokerCatalogEntryById(candidate.brokerId) : undefined);
    exposures.push(exposureFromBroker(broker, candidate, scored, input.caseId, new Date().toISOString()));
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

export function countFindingsByStatus(exposures: Exposure[]): {
  pending: number;
  confirmed: number;
  rejected: number;
} {
  let pending = 0;
  let confirmed = 0;
  let rejected = 0;
  for (const exposure of exposures) {
    const status = exposure.matchStatus ?? "pending";
    if (status === "confirmed") confirmed += 1;
    else if (status === "rejected") rejected += 1;
    else pending += 1;
  }
  return { pending, confirmed, rejected };
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
  const braveReady = isBraveSearchConfigured();
  const veniceReady = isVeniceConfigured();
  const pastedCount = input.pastedUrlCount ?? 0;
  const brokerSweepEnabled =
    input.brokerSweep !== false && !input.contentTakedown && braveReady;
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
      detail: `Site-scoped Brave search on ${sweepQueries.length} people-search brokers (${preview}${more}) for “${redactText(name)}”.`,
      enabled: true
    });
  }

  if (braveReady && name && !input.contentTakedown) {
    methods.push({
      id: "web-search",
      label: "Web search",
      detail: `Broader Brave query: ${buildBraveSearchQuery(input.scope)}`,
      enabled: true
    });
  }

  if (input.contentTakedown && braveReady && name) {
    methods.push({
      id: "web-search",
      label: "Content search",
      detail: `Brave query for takedown targets: ${buildBraveSearchQuery(input.scope)}`,
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

  if (!braveReady && pastedCount === 0) {
    methods.push({
      id: "manual-only",
      label: "Automated search off",
      detail: "Set BRAVE_SEARCH_API_KEY on the server, or paste profile URLs you already found.",
      enabled: false
    });
  }

  const canAutoDiscover = braveReady || pastedCount > 0;
  const summary = canAutoDiscover
    ? "Discover runs the steps below using only redacted case labels — never raw vault data."
    : "Paste at least one profile URL below, or enable Brave search on the server.";

  return { methods, canAutoDiscover, summary };
}

export function discoveryReadinessMessage(): string {
  const parts: string[] = [];
  if (isBraveSearchConfigured()) parts.push("Brave search + broker sweep");
  if (isVeniceConfigured()) parts.push("Venice match scoring");
  if (!parts.length) return "Paste URLs to discover listings (configure BRAVE_SEARCH_API_KEY for automated search).";
  return `${parts.join(" + ")} ready. Paste known links or run search.`;
}

export function logSafeDiscoveryError(error: unknown): Record<string, unknown> {
  return sanitizeForLog(error) as Record<string, unknown>;
}