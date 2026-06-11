import { brokerForUrl } from "./brokerCatalog.js";
import type { RedactedScope } from "./types.js";

export type DiscoveryMatchScore = "likely" | "uncertain" | "unlikely";

const PROFILE_PATH_HINT =
  /\/(people|person|name|profile|p|find|listing|background|records|details|lookup)\//i;

const JUNK_PATH_HINT =
  /\/(opt-?out|removal|remove|privacy|suppression|block|contact|about|help|faq|terms|login|signup|search|results)(\/|$|\?|-)/i;

export function nameSlugVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const hyphenated = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const parts = lower.split(/\s+/).filter(Boolean);
  const firstLast =
    parts.length >= 2 ? `${parts[0]}-${parts[parts.length - 1]}` : "";
  return [...new Set([hyphenated, compact, firstLast].filter((item) => item.length > 2))];
}

export function regionTokens(regionLabel?: string): string[] {
  if (!regionLabel?.trim()) return [];
  const raw = regionLabel.trim().toLowerCase();
  const tokens = raw
    .split(/[,\s]+/)
    .map((item) => item.replace(/[^a-z0-9]/g, ""))
    .filter((item) => item.length > 2);
  return [...new Set([raw, ...tokens])];
}

export function isJunkDiscoveryUrl(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (JUNK_PATH_HINT.test(path)) return true;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return true;
    if (segments.length === 1 && /^(www)?$/i.test(segments[0] ?? "")) return true;
    return false;
  } catch {
    return true;
  }
}

export function isProfileLikePath(sourceUrl: string): boolean {
  try {
    const path = new URL(sourceUrl).pathname;
    if (PROFILE_PATH_HINT.test(path)) return true;
    const segments = path.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

function nameTokens(scope: RedactedScope): string[] {
  return [scope.personLabel, ...(scope.aliases ?? [])]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item && item.length > 2));
}

function haystackForCandidate(input: {
  sourceUrl: string;
  title?: string;
  snippet?: string;
}): string {
  return `${input.sourceUrl} ${input.title ?? ""} ${input.snippet ?? ""}`.toLowerCase();
}

function nameMatchSignals(haystack: string, names: string[]): {
  exact: boolean;
  slug: boolean;
} {
  let exact = false;
  let slug = false;
  for (const name of names) {
    if (haystack.includes(name) || haystack.includes(name.replace(/\s+/g, "-"))) {
      exact = true;
    }
    for (const variant of nameSlugVariants(name)) {
      if (haystack.includes(variant)) slug = true;
    }
  }
  return { exact, slug };
}

function regionMatchSignals(haystack: string, scope: RedactedScope): boolean {
  const labels = [
    ...(scope.approvedIdentifierLabels ?? []),
    ...(scope.sensitiveConstraints ?? [])
  ];
  const tokens = labels.flatMap((item) => regionTokens(item));
  return tokens.some((token) => token.length > 2 && haystack.includes(token));
}

export function scoreDiscoveryCandidate(
  candidate: { sourceUrl: string; title?: string; snippet?: string },
  scope: RedactedScope
): { matchScore: DiscoveryMatchScore; matchReason: string } {
  if (isJunkDiscoveryUrl(candidate.sourceUrl)) {
    return { matchScore: "unlikely", matchReason: "Filtered: opt-out, search, or non-profile page." };
  }

  const haystack = haystackForCandidate(candidate);
  const names = nameTokens(scope);
  const { exact: nameExact, slug: nameSlug } = nameMatchSignals(haystack, names);
  const brokerHit = Boolean(brokerForUrl(candidate.sourceUrl));
  const profileLike = isProfileLikePath(candidate.sourceUrl);
  const regionHit = regionMatchSignals(haystack, scope);

  if (!brokerHit) {
    return { matchScore: "unlikely", matchReason: "Not a known people-search broker host." };
  }

  if ((nameExact || nameSlug) && profileLike && (regionHit || names.length === 0)) {
    return {
      matchScore: "likely",
      matchReason: nameSlug && !nameExact
        ? "Name matches URL slug on a profile-like broker page."
        : "Name and broker profile path align."
    };
  }

  if ((nameExact || nameSlug) && profileLike) {
    return {
      matchScore: "likely",
      matchReason: "Name matches a profile-like listing on this broker."
    };
  }

  if (nameExact && regionHit) {
    return { matchScore: "likely", matchReason: "Name and location appear in the listing." };
  }

  if (nameSlug || nameExact || regionHit) {
    return {
      matchScore: "uncertain",
      matchReason: nameSlug && !nameExact
        ? "Partial name match in URL; confirm this is your profile."
        : regionHit
          ? "Broker hit with location hint; name match is weak."
          : "Broker listing found; confirm the profile is yours."
    };
  }

  if (profileLike) {
    return {
      matchScore: "uncertain",
      matchReason: "Profile-like broker URL without a strong name match."
    };
  }

  return {
    matchScore: "unlikely",
    matchReason: "Generic broker page without name or profile signals."
  };
}

export function compareMatchScores(left: DiscoveryMatchScore, right: DiscoveryMatchScore): number {
  const rank: Record<DiscoveryMatchScore, number> = { likely: 0, uncertain: 1, unlikely: 2 };
  return rank[left] - rank[right];
}