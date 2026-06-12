import { pwnedPasswordRangeUrl } from "../cleanup.js";
import { followUpDate } from "../deadlines.js";
import type { ConnectorResult } from "../types.js";

const HIBP_USER_AGENT = "oblivion-privacy-agent";

export async function fetchHibpPasswordRange(hashPrefix: string): Promise<{
  suffixCount: number;
  status: "ready" | "failed";
  rangeUrl: string;
}> {
  const rangeUrl = pwnedPasswordRangeUrl(hashPrefix);
  let suffixCount = 0;
  let status: "ready" | "failed" = "ready";
  try {
    const hibpResponse = await fetch(rangeUrl, {
      headers: {
        "user-agent": HIBP_USER_AGENT,
        "add-padding": "true"
      }
    });
    if (!hibpResponse.ok) throw new Error(`hibp-password-range-${hibpResponse.status}`);
    const text = await hibpResponse.text();
    suffixCount = text.trim() ? text.trim().split(/\r?\n/).length : 0;
  } catch {
    status = "failed";
  }
  return { suffixCount, status, rangeUrl };
}

export async function fetchHibpEmailBreach(email: string): Promise<Response> {
  if (!process.env.HIBP_API_KEY?.trim()) {
    throw Object.assign(new Error("hibp-api-key-not-configured"), { statusCode: 503 });
  }
  return fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
    {
      headers: {
        "hibp-api-key": process.env.HIBP_API_KEY,
        "user-agent": HIBP_USER_AGENT
      }
    }
  );
}

export function hibpEmailResultStatus(response: Response): ConnectorResult["status"] {
  if (response.status === 404) return "recorded";
  return response.ok ? "ready" : "failed";
}

export function buildHibpPasswordRangeConnectorResult(
  caseId: string,
  hashPrefix: string,
  input: { suffixCount: number; status: "ready" | "failed"; rangeUrl: string }
): ConnectorResult {
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "hibp-password-range",
    status: input.status,
    sourceUrl: input.rangeUrl,
    officialRemovalPath: "https://haveibeenpwned.com/API/v3#PwnedPasswords",
    confidence: "high",
    requiresUserHandoff: false,
    nextCheckAt: followUpDate(30),
    summary: `Pwned Passwords range checked with only a SHA-1 prefix; ${input.suffixCount} padded suffix rows returned.`,
    createdAt: new Date().toISOString()
  };
}

export function buildHibpEmailConnectorResult(caseId: string, response: Response): ConnectorResult {
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "hibp-email",
    status: hibpEmailResultStatus(response),
    sourceUrl: "https://haveibeenpwned.com/api/v3/breachedaccount",
    officialRemovalPath: "https://haveibeenpwned.com/API/v3",
    confidence: "high",
    requiresUserHandoff: false,
    nextCheckAt: followUpDate(30),
    summary:
      response.status === 404
        ? "HIBP reports no breach record for the approved email."
        : "HIBP email check completed or requires review.",
    createdAt: new Date().toISOString()
  };
}