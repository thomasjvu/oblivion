import type { IdentifierCategory, Jurisdiction } from "./types.js";

export type BrokerSubmissionMethod = "web-form" | "email" | "portal" | "postal" | "drop";

export interface BrokerCatalogEntry {
  brokerId: string;
  brokerLabel: string;
  primaryHost: string;
  hostPatterns: RegExp[];
  officialOptOutUrl: string;
  officialRemovalPath: string;
  submissionMethod: BrokerSubmissionMethod;
  privacyEmail?: string;
  jurisdictions: Jurisdiction[];
  typicalIdentifiers: IdentifierCategory[];
  requiresIdVerification: boolean;
  recheckDays: number;
  teeAutomatable: boolean;
  tier: 1 | 2;
}

interface BrokerCatalogSeed {
  brokerId: string;
  brokerLabel: string;
  hostSuffix: string;
  officialOptOutUrl: string;
  submissionMethod: BrokerSubmissionMethod;
  privacyEmail?: string;
  jurisdictions?: Jurisdiction[];
  typicalIdentifiers?: IdentifierCategory[];
  requiresIdVerification?: boolean;
  recheckDays?: number;
  tier?: 1 | 2;
}

const DEFAULT_IDENTIFIERS: IdentifierCategory[] = ["legal-name", "email", "city-state"];

function seedToEntry(seed: BrokerCatalogSeed): BrokerCatalogEntry {
  const hostSuffix = seed.hostSuffix.replace(/^www\./, "");
  const escaped = hostSuffix.replace(/\./g, "\\.");
  const tier = seed.tier ?? (seed.requiresIdVerification ? 2 : 1);
  const submissionMethod = seed.submissionMethod;
  const requiresIdVerification = seed.requiresIdVerification ?? false;
  const teeAutomatable =
    tier === 1 &&
    !requiresIdVerification &&
    (submissionMethod === "web-form" || submissionMethod === "email");
  return {
    brokerId: seed.brokerId,
    brokerLabel: seed.brokerLabel,
    primaryHost: hostSuffix,
    hostPatterns: [new RegExp(escaped, "i")],
    officialOptOutUrl: seed.officialOptOutUrl,
    officialRemovalPath: seed.officialOptOutUrl,
    submissionMethod,
    privacyEmail: seed.privacyEmail,
    jurisdictions: seed.jurisdictions ?? ["US", "EU", "UK"],
    typicalIdentifiers: seed.typicalIdentifiers ?? DEFAULT_IDENTIFIERS,
    requiresIdVerification,
    recheckDays: seed.recheckDays ?? (tier === 1 ? 14 : 30),
    teeAutomatable,
    tier
  };
}

const BROKER_CATALOG_SEEDS: BrokerCatalogSeed[] = [
  { brokerId: "spokeo", brokerLabel: "Spokeo", hostSuffix: "spokeo.com", officialOptOutUrl: "https://www.spokeo.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "beenverified", brokerLabel: "BeenVerified", hostSuffix: "beenverified.com", officialOptOutUrl: "https://www.beenverified.com/app/optout/search", submissionMethod: "web-form" },
  { brokerId: "whitepages", brokerLabel: "Whitepages", hostSuffix: "whitepages.com", officialOptOutUrl: "https://www.whitepages.com/suppression-requests", submissionMethod: "web-form" },
  { brokerId: "intelius", brokerLabel: "Intelius", hostSuffix: "intelius.com", officialOptOutUrl: "https://www.intelius.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "truthfinder", brokerLabel: "TruthFinder", hostSuffix: "truthfinder.com", officialOptOutUrl: "https://www.truthfinder.com/opt-out/", submissionMethod: "web-form" },
  { brokerId: "instantcheckmate", brokerLabel: "Instant Checkmate", hostSuffix: "instantcheckmate.com", officialOptOutUrl: "https://www.instantcheckmate.com/opt-out/", submissionMethod: "web-form" },
  { brokerId: "mylife", brokerLabel: "MyLife", hostSuffix: "mylife.com", officialOptOutUrl: "https://www.mylife.com/ccpa/index.pubview", submissionMethod: "portal", requiresIdVerification: true, tier: 2 },
  { brokerId: "radaris", brokerLabel: "Radaris", hostSuffix: "radaris.com", officialOptOutUrl: "https://radaris.com/control/privacy", submissionMethod: "web-form" },
  { brokerId: "fastbackgroundcheck", brokerLabel: "FastBackgroundCheck", hostSuffix: "fastbackgroundcheck.com", officialOptOutUrl: "https://www.fastbackgroundcheck.com/optout", submissionMethod: "web-form" },
  { brokerId: "thatsthem", brokerLabel: "ThatsThem", hostSuffix: "thatsthem.com", officialOptOutUrl: "https://thatsthem.com/optout", submissionMethod: "web-form" },
  { brokerId: "anywho", brokerLabel: "AnyWho", hostSuffix: "anywho.com", officialOptOutUrl: "https://www.anywho.com/contact", submissionMethod: "email", privacyEmail: "privacy@anywho.com" },
  { brokerId: "rocketreach", brokerLabel: "RocketReach", hostSuffix: "rocketreach.co", officialOptOutUrl: "https://rocketreach.co/privacy", submissionMethod: "web-form" },
  { brokerId: "nuwber", brokerLabel: "Nuwber", hostSuffix: "nuwber.com", officialOptOutUrl: "https://nuwber.com/removal/link", submissionMethod: "web-form" },
  { brokerId: "truepeoplesearch", brokerLabel: "TruePeopleSearch", hostSuffix: "truepeoplesearch.com", officialOptOutUrl: "https://www.truepeoplesearch.com/removal", submissionMethod: "web-form" },
  { brokerId: "fastpeoplesearch", brokerLabel: "FastPeopleSearch", hostSuffix: "fastpeoplesearch.com", officialOptOutUrl: "https://www.fastpeoplesearch.com/removal", submissionMethod: "web-form" },
  { brokerId: "usphonebook", brokerLabel: "USPhonebook", hostSuffix: "usphonebook.com", officialOptOutUrl: "https://www.usphonebook.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "clustrmaps", brokerLabel: "ClustrMaps", hostSuffix: "clustrmaps.com", officialOptOutUrl: "https://clustrmaps.com/bl/opt-out", submissionMethod: "web-form" },
  { brokerId: "peekyou", brokerLabel: "PeekYou", hostSuffix: "peekyou.com", officialOptOutUrl: "https://www.peekyou.com/about/contact/optout", submissionMethod: "web-form" },
  { brokerId: "zabasearch", brokerLabel: "ZabaSearch", hostSuffix: "zabasearch.com", officialOptOutUrl: "https://www.zabasearch.com/block_records/", submissionMethod: "web-form" },
  { brokerId: "addresses", brokerLabel: "Addresses.com", hostSuffix: "addresses.com", officialOptOutUrl: "https://www.addresses.com/optout.php", submissionMethod: "web-form" },
  { brokerId: "peoplefinders", brokerLabel: "PeopleFinders", hostSuffix: "peoplefinders.com", officialOptOutUrl: "https://www.peoplefinders.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "peoplelooker", brokerLabel: "PeopleLooker", hostSuffix: "peoplelooker.com", officialOptOutUrl: "https://www.peoplelooker.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "checkpeople", brokerLabel: "CheckPeople", hostSuffix: "checkpeople.com", officialOptOutUrl: "https://www.checkpeople.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "searchpeoplefree", brokerLabel: "SearchPeopleFree", hostSuffix: "searchpeoplefree.com", officialOptOutUrl: "https://www.searchpeoplefree.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "familytreenow", brokerLabel: "FamilyTreeNow", hostSuffix: "familytreenow.com", officialOptOutUrl: "https://www.familytreenow.com/optout", submissionMethod: "web-form" },
  { brokerId: "cyberbackgroundchecks", brokerLabel: "CyberBackgroundChecks", hostSuffix: "cyberbackgroundchecks.com", officialOptOutUrl: "https://www.cyberbackgroundchecks.com/removal", submissionMethod: "web-form" },
  { brokerId: "verecor", brokerLabel: "Verecor", hostSuffix: "verecor.com", officialOptOutUrl: "https://verecor.com/ng/control/privacy", submissionMethod: "web-form" },
  { brokerId: "neighborwho", brokerLabel: "NeighborWho", hostSuffix: "neighborwho.com", officialOptOutUrl: "https://www.neighborwho.com/opt-out/", submissionMethod: "web-form" },
  { brokerId: "infotracer", brokerLabel: "InfoTracer", hostSuffix: "infotracer.com", officialOptOutUrl: "https://infotracer.com/optout/", submissionMethod: "web-form" },
  { brokerId: "golookup", brokerLabel: "GoLookup", hostSuffix: "golookup.com", officialOptOutUrl: "https://golookup.com/support/optout", submissionMethod: "web-form" },
  { brokerId: "idtrue", brokerLabel: "IDTrue", hostSuffix: "idtrue.com", officialOptOutUrl: "https://www.idtrue.com/optout/", submissionMethod: "web-form" },
  { brokerId: "persopo", brokerLabel: "Persopo", hostSuffix: "persopo.com", officialOptOutUrl: "https://persopo.com/optout", submissionMethod: "web-form" },
  { brokerId: "publicrecordsnow", brokerLabel: "PublicRecordsNow", hostSuffix: "publicrecordsnow.com", officialOptOutUrl: "https://www.publicrecordsnow.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "smartbackgroundchecks", brokerLabel: "SmartBackgroundChecks", hostSuffix: "smartbackgroundchecks.com", officialOptOutUrl: "https://www.smartbackgroundchecks.com/optout", submissionMethod: "web-form" },
  { brokerId: "spyfly", brokerLabel: "SpyFly", hostSuffix: "spyfly.com", officialOptOutUrl: "https://www.spyfly.com/help-center/opt-out", submissionMethod: "web-form" },
  { brokerId: "ussearch", brokerLabel: "US Search", hostSuffix: "ussearch.com", officialOptOutUrl: "https://www.ussearch.com/opt-out/submit/", submissionMethod: "web-form" },
  { brokerId: "veripages", brokerLabel: "VeriPages", hostSuffix: "veripages.com", officialOptOutUrl: "https://veripages.com/remove", submissionMethod: "web-form" },
  { brokerId: "centeda", brokerLabel: "Centeda", hostSuffix: "centeda.com", officialOptOutUrl: "https://centeda.com/remove", submissionMethod: "web-form" },
  { brokerId: "unitedstatesphonebook", brokerLabel: "United States Phonebook", hostSuffix: "unitedstatesphonebook.com", officialOptOutUrl: "https://www.unitedstatesphonebook.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "publicdatacheck", brokerLabel: "PublicDataCheck", hostSuffix: "publicdatacheck.com", officialOptOutUrl: "https://www.publicdatacheck.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "recordsfinderusa", brokerLabel: "RecordsFinderUSA", hostSuffix: "recordsfinderusa.com", officialOptOutUrl: "https://recordsfinderusa.com/optout/", submissionMethod: "web-form" },
  { brokerId: "searchquarry", brokerLabel: "SearchQuarry", hostSuffix: "searchquarry.com", officialOptOutUrl: "https://www.searchquarry.com/opt-out/", submissionMethod: "web-form" },
  { brokerId: "backgroundchecks", brokerLabel: "BackgroundChecks.org", hostSuffix: "backgroundchecks.org", officialOptOutUrl: "https://www.backgroundchecks.org/opt-out/", submissionMethod: "web-form" },
  { brokerId: "officialusa", brokerLabel: "OfficialUSA", hostSuffix: "officialusa.com", officialOptOutUrl: "https://www.officialusa.com/opt-out/", submissionMethod: "web-form" },
  { brokerId: "peoplebyname", brokerLabel: "PeopleByName", hostSuffix: "peoplebyname.com", officialOptOutUrl: "https://www.peoplebyname.com/remove/", submissionMethod: "web-form" },
  { brokerId: "privateeye", brokerLabel: "PrivateEye", hostSuffix: "privateeye.com", officialOptOutUrl: "https://www.privateeye.com/static/view/optout/", submissionMethod: "web-form", requiresIdVerification: true, tier: 2 },
  { brokerId: "zoominfo", brokerLabel: "ZoomInfo", hostSuffix: "zoominfo.com", officialOptOutUrl: "https://www.zoominfo.com/privacy-center", submissionMethod: "portal", requiresIdVerification: true, tier: 2 },
  { brokerId: "acxiom", brokerLabel: "Acxiom", hostSuffix: "acxiom.com", officialOptOutUrl: "https://isapps.acxiom.com/optout/optout.aspx", submissionMethod: "portal", requiresIdVerification: true, tier: 2, recheckDays: 45 },
  { brokerId: "lexisnexis", brokerLabel: "LexisNexis", hostSuffix: "lexisnexis.com", officialOptOutUrl: "https://optout.lexisnexis.com/", submissionMethod: "portal", requiresIdVerification: true, tier: 2, recheckDays: 45 },
  { brokerId: "contactout", brokerLabel: "ContactOut", hostSuffix: "contactout.com", officialOptOutUrl: "https://contactout.com/optout", submissionMethod: "web-form" },
  { brokerId: "numlookup", brokerLabel: "NumLookup", hostSuffix: "numlookup.com", officialOptOutUrl: "https://www.numlookup.com/opt-out", submissionMethod: "email", privacyEmail: "privacy@numlookup.com" },
  { brokerId: "yasni", brokerLabel: "Yasni", hostSuffix: "yasni.com", officialOptOutUrl: "https://www.yasni.com/optout.php", submissionMethod: "web-form" },
  { brokerId: "publicsearcher", brokerLabel: "PublicSearcher", hostSuffix: "publicsearcher.com", officialOptOutUrl: "https://www.publicsearcher.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "findpeoplesearch", brokerLabel: "FindPeopleSearch", hostSuffix: "findpeoplesearch.com", officialOptOutUrl: "https://www.findpeoplesearch.com/opt-out", submissionMethod: "web-form" },
  { brokerId: "courtrecords", brokerLabel: "CourtRecords.org", hostSuffix: "courtrecords.org", officialOptOutUrl: "https://www.courtrecords.org/opt-out/", submissionMethod: "web-form" },
  { brokerId: "reversephonelookup", brokerLabel: "ReversePhoneLookup", hostSuffix: "reversephonelookup.com", officialOptOutUrl: "https://www.reversephonelookup.com/opt-out", submissionMethod: "web-form" }
];

export const BROKER_CATALOG: BrokerCatalogEntry[] = BROKER_CATALOG_SEEDS.map(seedToEntry);

export const BROKER_HOST_HINT =
  /people-?search|background.?check|whitepages|spokeo|beenverified|rocketreach|thatsthem|anywho|fastbackgroundcheck|intelius|truthfinder|instantcheckmate|mylife|radaris|nuwber|truepeoplesearch|fastpeoplesearch|peekyou|zabasearch|peoplefinders|peoplelooker|familytreenow|cyberbackgroundchecks|neighborwho|infotracer|ussearch|veripages|numlookup|contactout/i;

export function brokerCatalogEntryById(brokerId: string): BrokerCatalogEntry | undefined {
  return BROKER_CATALOG.find((entry) => entry.brokerId === brokerId);
}

export function brokerForUrl(url: string): BrokerCatalogEntry | undefined {
  try {
    const host = new URL(url).hostname;
    return BROKER_CATALOG.find((entry) => entry.hostPatterns.some((pattern) => pattern.test(host)));
  } catch {
    return undefined;
  }
}

export function tier1BrokersForJurisdiction(jurisdiction: Jurisdiction): BrokerCatalogEntry[] {
  return BROKER_CATALOG.filter((entry) => entry.tier === 1 && entry.jurisdictions.includes(jurisdiction));
}

export function brokerSweepLimit(): number {
  const raw = process.env.BROKER_SWEEP_LIMIT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 12;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 25) : 12;
}

export function buildBrokerSweepQueries(scope: { personLabel?: string; aliases?: string[] } | undefined): Array<{
  brokerId: string;
  host: string;
  query: string;
}> {
  const parts = [scope?.personLabel, ...(scope?.aliases ?? [])]
    .map((item) => item?.trim())
    .filter(Boolean);
  const name = parts.length ? parts.join(" ") : "";
  if (!name) return [];
  const brokers = tier1BrokersForJurisdiction("US").filter((entry) => entry.teeAutomatable);
  return brokers.slice(0, brokerSweepLimit()).map((entry) => ({
    brokerId: entry.brokerId,
    host: entry.primaryHost,
    query: `"${name}" site:${entry.primaryHost}`
  }));
}

export function dataToDiscloseForBroker(
  entry: BrokerCatalogEntry,
  allowed: IdentifierCategory[]
): IdentifierCategory[] {
  const allowedSet = new Set(allowed);
  return entry.typicalIdentifiers.filter((category) => allowedSet.has(category));
}

export function validateBrokerCatalog(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of BROKER_CATALOG) {
    if (ids.has(entry.brokerId)) errors.push(`duplicate-broker-id:${entry.brokerId}`);
    ids.add(entry.brokerId);
    if (!entry.officialOptOutUrl.startsWith("https://")) errors.push(`invalid-opt-out-url:${entry.brokerId}`);
    if (entry.requiresIdVerification && entry.teeAutomatable) {
      errors.push(`tee-automatable-conflicts-with-id-verification:${entry.brokerId}`);
    }
    if (entry.tier === 1 && entry.requiresIdVerification) {
      errors.push(`tier1-requires-id-verification:${entry.brokerId}`);
    }
  }
  if (BROKER_CATALOG.length < 50) errors.push(`catalog-too-small:${BROKER_CATALOG.length}`);
  return errors;
}