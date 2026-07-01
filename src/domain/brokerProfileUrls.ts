import { nameSlugVariants } from "./discoveryHeuristics.js";
import { brokerCatalogEntryById, buildBrokerSweepQueries } from "./brokerCatalog.js";
import { normalizeDiscoveryUrl } from "./discoveryUrl.js";

const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC"
};

const ABBR_TO_STATE = Object.fromEntries(
  Object.entries(US_STATE_ABBR).map(([name, abbr]) => [abbr.toLowerCase(), name])
);

export interface ParsedRegion {
  city?: string;
  stateAbbr?: string;
  stateName?: string;
  raw: string;
}

function slugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleSlug(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

export function parseRegionLabel(region?: string): ParsedRegion | undefined {
  const raw = region?.trim();
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  let city: string | undefined;
  let stateToken: string | undefined;
  if (parts.length >= 2) {
    city = parts[0];
    stateToken = parts[parts.length - 1];
  } else {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const last = tokens[tokens.length - 1]?.toLowerCase();
    if (last && (US_STATE_ABBR[last] || last.length === 2)) {
      stateToken = tokens[tokens.length - 1];
      city = tokens.slice(0, -1).join(" ") || undefined;
    } else {
      city = raw;
    }
  }
  const stateLower = stateToken?.toLowerCase();
  const stateAbbr =
    stateLower && stateLower.length === 2
      ? stateLower.toUpperCase()
      : stateLower
        ? US_STATE_ABBR[stateLower]
        : undefined;
  const stateName = stateAbbr ? ABBR_TO_STATE[stateAbbr.toLowerCase()] : stateLower;
  return { city, stateAbbr, stateName, raw };
}

function firstLastSlugs(name: string): string[] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return nameSlugVariants(name);
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
  const variants = new Set<string>();
  variants.add(`${slugPart(first)}-${slugPart(last)}`);
  variants.add(`${slugPart(first)}-${slugPart(middle)}-${slugPart(last)}`.replace(/-+/g, "-"));
  for (const item of nameSlugVariants(name)) variants.add(item);
  return [...variants].filter((item) => item.length > 2);
}

type ProfileUrlBuilder = (input: {
  name: string;
  region?: ParsedRegion;
  nameSlug: string;
  titleNameSlug: string;
}) => string[];

const PROFILE_URL_BUILDERS: Record<string, ProfileUrlBuilder> = {
  fastpeoplesearch: ({ nameSlug, region }) => {
    const urls: string[] = [];
    const state = region?.stateAbbr?.toLowerCase();
    const city = region?.city ? slugPart(region.city) : undefined;
    if (state && city) urls.push(`https://www.fastpeoplesearch.com/name/${nameSlug}_${state}/${city}`);
    if (state) urls.push(`https://www.fastpeoplesearch.com/name/${nameSlug}_${state}`);
    urls.push(`https://www.fastpeoplesearch.com/name/${nameSlug}`);
    return urls;
  },
  truepeoplesearch: ({ nameSlug, region }) => {
    const urls = [`https://www.truepeoplesearch.com/results?name=${encodeURIComponent(nameSlug.replace(/-/g, " "))}`];
    const state = region?.stateAbbr?.toLowerCase();
    const city = region?.city ? slugPart(region.city) : undefined;
    if (state && city) urls.unshift(`https://www.truepeoplesearch.com/find/person/${nameSlug}/${city}-${state}`);
    return urls;
  },
  spokeo: ({ titleNameSlug, region }) => {
    const cityState = region?.city && region.stateAbbr ? `${titleSlug(region.city)}-${region.stateAbbr}` : undefined;
    if (cityState) return [`https://www.spokeo.com/${titleNameSlug}/${cityState}`];
    return [`https://www.spokeo.com/${titleNameSlug}`];
  },
  thatsthem: ({ titleNameSlug }) => [`https://thatsthem.com/name/${titleNameSlug}`],
  whitepages: ({ titleNameSlug, region }) => {
    const cityState =
      region?.city && region.stateAbbr ? `${titleSlug(region.city)}-${region.stateAbbr}` : undefined;
    if (cityState) return [`https://www.whitepages.com/name/${titleNameSlug}/${cityState}`];
    return [`https://www.whitepages.com/name/${titleNameSlug}`];
  },
  beenverified: ({ nameSlug }) => [`https://www.beenverified.com/people/${nameSlug}/`],
  peekyou: ({ nameSlug }) => [`https://www.peekyou.com/${nameSlug.replace(/-/g, "_")}`],
  radaris: ({ name }) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return [];
    return [`https://radaris.com/p/${titleSlug(parts[0])}/${titleSlug(parts[parts.length - 1])}/`];
  },
  fastbackgroundcheck: ({ nameSlug }) => [
    `https://www.fastbackgroundcheck.com/people/${nameSlug}`,
    `https://www.fastbackgroundcheck.com/people/${nameSlug}/id`
  ],
  anywho: ({ nameSlug, region }) => {
    const city = region?.city ? slugPart(region.city).replace(/-/g, "+") : "unknown";
    return [`https://www.anywho.com/people/${nameSlug.replace(/-/g, "+")}/${city}`];
  }
};

export function buildBrokerProfileUrlCandidates(
  name: string,
  regionLabel?: string,
  options?: { limit?: number; brokerLimit?: number }
): Array<{ brokerId: string; sourceUrl: string }> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const region = parseRegionLabel(regionLabel);
  const limit = options?.limit ?? 20;
  const brokerIds = [
    ...new Set(
      buildBrokerSweepQueries({ personLabel: trimmed, regionLabel }, {
        limit: options?.brokerLimit ?? 12,
        preview: false
      }).map((item) => item.brokerId)
    )
  ];
  const seen = new Set<string>();
  const results: Array<{ brokerId: string; sourceUrl: string }> = [];

  for (const brokerId of brokerIds) {
    const builder = PROFILE_URL_BUILDERS[brokerId];
    if (!builder) continue;
    const entry = brokerCatalogEntryById(brokerId);
    if (!entry) continue;
    for (const nameSlug of firstLastSlugs(trimmed)) {
      const titleNameSlug = titleSlug(trimmed.replace(/\s+/g, "-"));
      for (const rawUrl of builder({ name: trimmed, region, nameSlug, titleNameSlug })) {
        const sourceUrl = normalizeDiscoveryUrl(rawUrl);
        if (!sourceUrl || seen.has(sourceUrl)) continue;
        seen.add(sourceUrl);
        results.push({ brokerId, sourceUrl });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}