import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AttestationProof } from "./types.js";

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
const DEFAULT_PHALA_VERIFIER = "https://cloud-api.phala.com/api/v1/attestations/verify";

export interface TrustCenterConfig {
  deploymentVersion: string;
  sourceCommit: string;
  expectedComposeHash: string;
  imageDigests: string[];
  attestationReport?: unknown;
  attestationReportUrl?: string | null;
  phalaVerifierEndpoint?: string | null;
  maxAttestationAgeSeconds?: number;
  verificationInstructions: string[];
}

export interface BuildAttestationOptions {
  fetchLive?: boolean;
  now?: Date;
}

type AttestationSource = "dstack" | "http" | "static";

let cachedLiveProof: { key: string; proof: AttestationProof; expiresAtMs: number } | null = null;

function attestationCacheKey(config: TrustCenterConfig): string {
  return `${config.expectedComposeHash}:${config.sourceCommit}:${config.deploymentVersion}`;
}

export function clearAttestationCacheForTests(): void {
  cachedLiveProof = null;
}

interface LiveEvidence {
  report: unknown;
  fetchedAt: string;
  hardwareQuoteVerified: boolean | null;
  composeHash?: string;
  mrConfig?: string;
  errors: string[];
  source: AttestationSource;
}

export async function buildAttestationProof(
  config: TrustCenterConfig,
  options: BuildAttestationOptions = {}
): Promise<AttestationProof> {
  const now = options.now ?? new Date();
  const maxAgeMs = (config.maxAttestationAgeSeconds ?? 600) * 1000;
  if (options.fetchLive && cachedLiveProof) {
    const cacheValid =
      cachedLiveProof.key === attestationCacheKey(config) &&
      cachedLiveProof.expiresAtMs > now.getTime();
    if (cacheValid) return cachedLiveProof.proof;
  }
  const errors: string[] = [];
  const digestErrors = validateImageDigests(config.imageDigests);
  errors.push(...digestErrors);

  const liveEvidence = options.fetchLive
    ? await fetchLiveEvidence(config, now)
    : buildStaticEvidence(config, now);

  errors.push(...liveEvidence.errors);

  const expectedComposeConfigured =
    Boolean(config.expectedComposeHash) && !config.expectedComposeHash.startsWith("replace-");
  const composeHashMatches =
    expectedComposeConfigured &&
    Boolean(liveEvidence.composeHash) &&
    liveEvidence.composeHash?.toLowerCase() === config.expectedComposeHash.toLowerCase();
  const attestationFresh = isFresh(liveEvidence.fetchedAt, config.maxAttestationAgeSeconds ?? 600, now);
  const imageDigestsPinned = digestErrors.length === 0 && config.imageDigests.length > 0;
  const hardwareQuoteVerified = liveEvidence.hardwareQuoteVerified;
  const attestationWired =
    liveEvidence.source === "dstack" ||
    Boolean(config.attestationReportUrl && !String(config.attestationReportUrl).startsWith("replace-"));

  if (!expectedComposeConfigured) errors.push("expected-compose-hash-not-configured");
  if (liveEvidence.composeHash && !composeHashMatches) errors.push("compose-hash-mismatch");
  if (!attestationFresh) errors.push("attestation-stale");
  if (hardwareQuoteVerified === false) errors.push("hardware-quote-not-verified");

  const verifierResult =
    !attestationWired || errors.some((error) => error.includes("not-configured"))
      ? "not-configured"
      : errors.length === 0 && composeHashMatches && imageDigestsPinned && hardwareQuoteVerified === true
        ? "pass"
        : options.fetchLive
          ? "fail"
          : "not-configured";

  const proof: AttestationProof = {
    deploymentVersion: config.deploymentVersion,
    sourceCommit: config.sourceCommit,
    expectedComposeHash: config.expectedComposeHash,
    imageDigests: config.imageDigests,
    attestationReport: liveEvidence.report,
    verificationInstructions: config.verificationInstructions,
    verifierResult,
    checkedAt: now.toISOString(),
    attestationFresh,
    composeHashMatches,
    imageDigestsPinned,
    hardwareQuoteVerified,
    trustSummary: summarizeTrust(verifierResult),
    verificationErrors: [...new Set(errors)]
  };
  if (options.fetchLive) {
    cachedLiveProof = {
      key: attestationCacheKey(config),
      proof,
      expiresAtMs: now.getTime() + maxAgeMs
    };
  }
  return proof;
}

export function validateImageDigests(imageDigests: string[]): string[] {
  const errors: string[] = [];
  for (const image of imageDigests) {
    if (!DIGEST_RE.test(image)) errors.push(`image-not-pinned:${image}`);
  }
  return errors;
}

export function extractComposeHash(report: unknown): string | undefined {
  const direct =
    findStringByKey(report, "compose_hash") ?? findStringByKey(report, "compose-hash");
  if (direct && /^[0-9a-f]{64}$/i.test(direct)) return direct.toLowerCase();
  const appCompose = findStringByKey(report, "app_compose");
  if (!appCompose) return undefined;
  return createHash("sha256").update(appCompose).digest("hex");
}

export function extractIntelQuote(report: unknown): string | undefined {
  return findStringByKey(report, "intel_quote") ?? findStringByKey(report, "quote");
}

export function quoteToHex(quote: string): string {
  const trimmed = quote.trim().replace(/^0x/i, "");
  if (/^[0-9a-f]+$/i.test(trimmed)) return trimmed;
  return Buffer.from(quote, "base64").toString("hex");
}

async function fetchLiveEvidence(config: TrustCenterConfig, now: Date): Promise<LiveEvidence> {
  const dstackEvidence = await fetchDstackEvidence(config, now);
  if (dstackEvidence) return dstackEvidence;
  if (config.attestationReportUrl) return fetchHttpAttestationReport(config, now);
  return buildStaticEvidence(config, now);
}

async function fetchDstackEvidence(config: TrustCenterConfig, now: Date): Promise<LiveEvidence | null> {
  const socketCandidates = [
    process.env.DSTACK_SOCKET_PATH,
    "/var/run/dstack.sock",
    "/run/dstack.sock",
    "/var/run/dstack/dstack.sock",
    "/run/dstack/dstack.sock"
  ].filter((value): value is string => Boolean(value));
  const socketPath = socketCandidates.find((candidate) => existsSync(candidate));
  if (!socketPath) return null;

  const errors: string[] = [];
  try {
    const { DstackClient } = await import("@phala/dstack-sdk");
    const client = new DstackClient(socketPath);
    if (!(await client.isReachable())) return null;

    const [quoteResult, infoResult] = await Promise.all([client.getQuote(""), client.info()]);
    const report = {
      quote: quoteResult.quote,
      intel_quote: quoteResult.quote,
      event_log: quoteResult.event_log,
      vm_config: quoteResult.vm_config,
      compose_hash: infoResult.compose_hash,
      info: { tcb_info: infoResult.tcb_info }
    };
    const quote = extractIntelQuote(report);
    const hardwareQuoteVerified = quote
      ? await verifyIntelQuote(quote, config.phalaVerifierEndpoint ?? DEFAULT_PHALA_VERIFIER)
      : null;
    if (!quote) errors.push("intel-quote-not-found");

    return {
      report,
      fetchedAt: now.toISOString(),
      hardwareQuoteVerified,
      composeHash: extractComposeHash(report),
      mrConfig: findStringByKey(report, "mrconfig"),
      errors,
      source: "dstack"
    };
  } catch (error) {
    return {
      report: null,
      fetchedAt: now.toISOString(),
      hardwareQuoteVerified: false,
      errors: [`dstack-attestation-error:${error instanceof Error ? error.message : "unknown"}`],
      source: "dstack"
    };
  }
}

async function fetchHttpAttestationReport(config: TrustCenterConfig, now: Date): Promise<LiveEvidence> {
  const errors: string[] = [];
  try {
    const response = await fetch(config.attestationReportUrl!);
    if (!response.ok) {
      return {
        report: null,
        fetchedAt: now.toISOString(),
        hardwareQuoteVerified: false,
        errors: [`attestation-fetch-failed:${response.status}`],
        source: "http"
      };
    }

    const report = await response.json();
    const quote = extractIntelQuote(report);
    const hardwareQuoteVerified = quote
      ? await verifyIntelQuote(quote, config.phalaVerifierEndpoint ?? DEFAULT_PHALA_VERIFIER)
      : null;

    if (!quote) errors.push("intel-quote-not-found");

    return {
      report,
      fetchedAt: now.toISOString(),
      hardwareQuoteVerified,
      composeHash: extractComposeHash(report),
      mrConfig: findStringByKey(report, "mrconfig"),
      errors,
      source: "http"
    };
  } catch (error) {
    return {
      report: null,
      fetchedAt: now.toISOString(),
      hardwareQuoteVerified: false,
      errors: [`attestation-fetch-error:${error instanceof Error ? error.message : "unknown"}`],
      source: "http"
    };
  }
}

function buildStaticEvidence(config: TrustCenterConfig, now: Date): LiveEvidence {
  return {
    report: config.attestationReport ?? null,
    fetchedAt: now.toISOString(),
    hardwareQuoteVerified: null,
    composeHash: extractComposeHash(config.attestationReport),
    mrConfig: findStringByKey(config.attestationReport, "mrconfig"),
    errors: ["live-attestation-not-wired"],
    source: "static"
  };
}

async function verifyIntelQuote(quote: string, verifierEndpoint: string): Promise<boolean> {
  try {
    const response = await fetch(verifierEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex: quoteToHex(quote) })
    });
    if (!response.ok) return false;
    const result = await response.json() as { quote?: { verified?: boolean }; verified?: boolean };
    return result.quote?.verified === true || result.verified === true;
  } catch {
    return false;
  }
}

function isFresh(fetchedAt: string, maxAgeSeconds: number, now: Date): boolean {
  const fetched = new Date(fetchedAt).getTime();
  return Number.isFinite(fetched) && now.getTime() - fetched <= maxAgeSeconds * 1000;
}

function summarizeTrust(result: AttestationProof["verifierResult"]): string {
  if (result === "pass") {
    return "Verified: live attestation, expected compose hash, pinned images, and hardware quote checks passed.";
  }
  if (result === "fail") {
    return "Not trusted: attestation was present but one or more verification checks failed.";
  }
  return "Not configured: live Phala attestation evidence is not wired for this environment yet.";
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string") return direct;
  for (const child of Object.values(record)) {
    const found = findStringByKey(child, key);
    if (found) return found;
  }
  return undefined;
}
