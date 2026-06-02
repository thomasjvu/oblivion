import { createHash } from "node:crypto";
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

interface LiveEvidence {
  report: unknown;
  fetchedAt: string;
  hardwareQuoteVerified: boolean | null;
  composeHash?: string;
  mrConfig?: string;
  errors: string[];
}

export async function buildAttestationProof(
  config: TrustCenterConfig,
  options: BuildAttestationOptions = {}
): Promise<AttestationProof> {
  const now = options.now ?? new Date();
  const errors: string[] = [];
  const digestErrors = validateImageDigests(config.imageDigests);
  errors.push(...digestErrors);

  const liveEvidence =
    options.fetchLive && config.attestationReportUrl
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

  if (!expectedComposeConfigured) errors.push("expected-compose-hash-not-configured");
  if (liveEvidence.composeHash && !composeHashMatches) errors.push("compose-hash-mismatch");
  if (!attestationFresh) errors.push("attestation-stale");
  if (hardwareQuoteVerified === false) errors.push("hardware-quote-not-verified");

  const verifierResult =
    errors.some((error) => error.includes("not-configured")) || !config.attestationReportUrl
      ? "not-configured"
      : errors.length === 0 && composeHashMatches && imageDigestsPinned && hardwareQuoteVerified === true
        ? "pass"
        : "fail";

  return {
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
}

export function validateImageDigests(imageDigests: string[]): string[] {
  const errors: string[] = [];
  for (const image of imageDigests) {
    if (!DIGEST_RE.test(image)) errors.push(`image-not-pinned:${image}`);
  }
  return errors;
}

export function extractComposeHash(report: unknown): string | undefined {
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
  const errors: string[] = [];
  try {
    const response = await fetch(config.attestationReportUrl!);
    if (!response.ok) {
      return {
        report: null,
        fetchedAt: now.toISOString(),
        hardwareQuoteVerified: false,
        errors: [`attestation-fetch-failed:${response.status}`]
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
      errors
    };
  } catch (error) {
    return {
      report: null,
      fetchedAt: now.toISOString(),
      hardwareQuoteVerified: false,
      errors: [`attestation-fetch-error:${error instanceof Error ? error.message : "unknown"}`]
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
    errors: config.attestationReportUrl ? [] : ["live-attestation-url-not-configured"]
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
