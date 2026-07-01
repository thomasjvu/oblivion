import { brokerForUrl } from "./brokerCatalog.js";
import { parseRegionLabel } from "./brokerProfileUrls.js";
import type { RedactedScope } from "./types.js";

export type DiscoveryMatchScore = "likely" | "uncertain" | "unlikely";

const PROFILE_PATH_HINT =
  /\/(people|person|name|profile|p|find|listing|background|records|details|lookup)\//i;

const BROKER_PROFILE_PATH_HINT =
  /\/(people|person|name|profile|p|find|listing|background|records|details|lookup)(\/|$)/i;

const JUNK_PATH_HINT =
  /\/(opt-?out|removal|remove|privacy|suppression|block|contact|about|help|faq|terms|login|signup|search|results|do-not-sell)(\/|$|\?|-)/i;

const DIRECTORY_LISTING_HINT = /\b\d+\s+matches?\b|search results|browse profiles|all results for/i;

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
    const parsed = new URL(sourceUrl);
    const path = parsed.pathname;
    if (PROFILE_PATH_HINT.test(path) || BROKER_PROFILE_PATH_HINT.test(path)) return true;
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    const host = parsed.hostname.toLowerCase();
    if (host.includes("spokeo.com") && segments.length >= 1 && segments.length <= 3) {
      return segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/i.test(segment));
    }
    if (segments.length >= 2) {
      const joined = segments.join("/").toLowerCase();
      if (/^[a-z][a-z0-9-]*\/[a-z]{2}(?:-[a-z][a-z0-9-]*)?$/i.test(joined)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function nameTokens(scope: RedactedScope): string[] {
  return [scope.personLabel, ...(scope.aliases ?? [])]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item && item.length > 2));
}

function stripListingMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function haystackForCandidate(input: {
  sourceUrl: string;
  title?: string;
  snippet?: string;
}): string {
  const title = stripListingMarkup(input.title ?? "");
  const snippet = stripListingMarkup(input.snippet ?? "");
  return `${input.sourceUrl} ${title} ${snippet}`.toLowerCase();
}

function listingTextHaystack(input: {
  title?: string;
  snippet?: string;
}): string {
  return `${stripListingMarkup(input.title ?? "")} ${stripListingMarkup(input.snippet ?? "")}`.toLowerCase();
}

function firstLastParts(name: string): { first: string; last: string } | null {
  const parts = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function firstLastSlugInPath(pathname: string, names: string[]): boolean {
  const pathLower = pathname.toLowerCase();
  for (const name of names) {
    const parts = firstLastParts(name);
    if (!parts) continue;
    const { first, last } = parts;
    const patterns = [
      `${first}-${last}`,
      `${first}_${last}`,
      `${first}/${last}`,
      `${first}+${last}`,
      `${first}.${last}`,
      `${first}%20${last}`
    ];
    if (patterns.some((pattern) => pathLower.includes(pattern))) return true;
    for (const variant of nameSlugVariants(name)) {
      if (!variant.includes(first) || !variant.includes(last)) continue;
      if (pathLower.includes(variant)) return true;
    }
  }
  return false;
}

export function nameInListingText(
  input: { title?: string; snippet?: string },
  names: string[]
): boolean {
  const haystack = listingTextHaystack(input);
  return names.some((name) => {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return false;
    if (haystack.includes(normalized)) return true;
    return haystack.includes(normalized.replace(/\s+/g, "-"));
  });
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

function regionLabels(scope: RedactedScope): string[] {
  return [...(scope.approvedIdentifierLabels ?? []), ...(scope.sensitiveConstraints ?? [])].filter(Boolean);
}

function regionMatchSignals(haystack: string, scope: RedactedScope): boolean {
  const tokens = regionLabels(scope).flatMap((item) => regionTokens(item));
  return tokens.some((token) => token.length > 2 && haystack.includes(token));
}

function parsedRegionFromScope(scope: RedactedScope) {
  for (const label of regionLabels(scope)) {
    const parsed = parseRegionLabel(label);
    if (parsed) return parsed;
  }
  return undefined;
}

function stateAbbreviationHit(haystack: string, abbr: string): boolean {
  const lower = abbr.toLowerCase();
  if (lower.length !== 2) return haystack.includes(lower);
  const pattern = new RegExp(`(^|[^a-z])${lower}([^a-z]|$)`, "i");
  return pattern.test(haystack);
}

function cityStateRegionHit(haystack: string, scope: RedactedScope): boolean {
  const parsed = parsedRegionFromScope(scope);
  if (!parsed?.city || !parsed.stateAbbr) return false;
  const cityCompact = parsed.city.toLowerCase().replace(/[^a-z0-9]/g, "");
  const citySpaced = parsed.city.toLowerCase().trim();
  const citySlug = citySpaced.replace(/[^a-z0-9]+/g, "-");
  if (cityCompact.length < 3 && citySpaced.length < 3) return false;
  const normalized = haystack.toLowerCase();
  const cityHit =
    (cityCompact.length >= 3 && normalized.includes(cityCompact)) ||
    (citySpaced.length >= 3 && normalized.includes(citySpaced)) ||
    (citySlug.length >= 3 && normalized.includes(citySlug));
  const stateHit =
    stateAbbreviationHit(normalized, parsed.stateAbbr) ||
    (parsed.stateName ? normalized.includes(parsed.stateName.toLowerCase()) : false) ||
    normalized.includes(parsed.raw.toLowerCase());
  return cityHit && stateHit;
}

function scopeRequiresCityState(scope: RedactedScope): boolean {
  const parsed = parsedRegionFromScope(scope);
  return Boolean(parsed?.city && parsed.stateAbbr);
}

function isDirectoryListingPage(input: {
  sourceUrl: string;
  title?: string;
  snippet?: string;
}): boolean {
  const text = listingTextHaystack(input);
  if (DIRECTORY_LISTING_HINT.test(text)) return true;
  try {
    const segments = new URL(input.sourceUrl).pathname.split("/").filter(Boolean);
    if (segments.length === 2) {
      const last = segments[segments.length - 1]?.toLowerCase() ?? "";
      if (/^(california|texas|florida|new-york|ohio|pennsylvania|[a-z]{2})$/i.test(last)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function scoreDiscoveryCandidate(
  candidate: { sourceUrl: string; title?: string; snippet?: string },
  scope: RedactedScope
): { matchScore: DiscoveryMatchScore; matchReason: string; confidencePercent: number } {
  if (isJunkDiscoveryUrl(candidate.sourceUrl)) {
    return {
      matchScore: "unlikely",
      matchReason: "Filtered: opt-out, search, or non-profile page.",
      confidencePercent: 12
    };
  }

  const haystack = haystackForCandidate(candidate);
  const names = nameTokens(scope);
  const { exact: nameExact, slug: nameSlug } = nameMatchSignals(haystack, names);
  const brokerHit = Boolean(brokerForUrl(candidate.sourceUrl));
  const profileLike = isProfileLikePath(candidate.sourceUrl);
  const regionHit = regionMatchSignals(haystack, scope);
  let pathFirstLast = false;
  try {
    pathFirstLast = firstLastSlugInPath(new URL(candidate.sourceUrl).pathname, names);
  } catch {
    pathFirstLast = false;
  }
  const listingNameHit = nameInListingText(candidate, names);

  if (!brokerHit) {
    return {
      matchScore: "unlikely",
      matchReason: "Not a known people-search broker host.",
      confidencePercent: 15
    };
  }

  if (isDirectoryListingPage(candidate)) {
    return {
      matchScore: "uncertain",
      matchReason: "Broker directory page with multiple matches; confirm the specific profile is yours.",
      confidencePercent: 42
    };
  }

  const requiresCityState = scopeRequiresCityState(scope);
  const cityStateHit = cityStateRegionHit(haystack, scope);

  if (profileLike && pathFirstLast && (!requiresCityState || cityStateHit)) {
    return {
      matchScore: "likely",
      matchReason: requiresCityState
        ? "Name and city/state appear aligned on this broker profile."
        : "Name appears in the profile URL on this broker.",
      confidencePercent: requiresCityState && cityStateHit ? 96 : 91
    };
  }

  if (profileLike && pathFirstLast && requiresCityState && !cityStateHit) {
    return {
      matchScore: "uncertain",
      matchReason: "Name matches the URL, but city/state does not align with your intake.",
      confidencePercent: 56
    };
  }

  if (listingNameHit && (!requiresCityState ? regionHit : cityStateHit)) {
    return {
      matchScore: "likely",
      matchReason: requiresCityState
        ? "Name and city/state appear in the listing."
        : "Name and location appear in the listing.",
      confidencePercent: requiresCityState && cityStateHit ? 89 : 84
    };
  }

  if ((nameExact || nameSlug) && profileLike) {
    return {
      matchScore: "uncertain",
      matchReason: "Profile-like broker page with a partial name match; confirm this is your listing.",
      confidencePercent: 52
    };
  }

  if (nameSlug || nameExact || regionHit) {
    return {
      matchScore: "uncertain",
      matchReason: nameSlug && !nameExact
        ? "Partial name match in URL; confirm this is your profile."
        : regionHit
          ? "Broker hit with location hint; name match is weak."
          : "Broker listing found; confirm the profile is yours.",
      confidencePercent: regionHit ? 48 : 44
    };
  }

  if (profileLike) {
    return {
      matchScore: "uncertain",
      matchReason: "Profile-like broker URL without a strong name match.",
      confidencePercent: 38
    };
  }

  return {
    matchScore: "unlikely",
    matchReason: "Generic broker page without name or profile signals.",
    confidencePercent: 22
  };
}

export function compareMatchScores(left: DiscoveryMatchScore, right: DiscoveryMatchScore): number {
  const rank: Record<DiscoveryMatchScore, number> = { likely: 0, uncertain: 1, unlikely: 2 };
  return rank[left] - rank[right];
}