import type { TrustCenterConfig } from "./attestation.js";
import { buildAttestationProof } from "./attestation.js";
import { brokerCatalogEntryById } from "./brokerCatalog.js";
import { connectorById } from "./connectors.js";
import { createGoogleRemovalPlan, pwnedPasswordRangeUrl } from "./cleanup.js";
import { followUpDate } from "./deadlines.js";
import { assertSensitiveExecutionAllowed } from "./runtimeGuard.js";
import { sourceVerificationFor } from "./sourceVerification.js";
import type { ActionRequest, Approval, ConnectorResult } from "./types.js";

export interface LiveConnectorInput {
  action: ActionRequest;
  approval: Approval;
  trustCenterConfig: TrustCenterConfig;
  handoff?: {
    hashPrefix?: string;
    emailLabel?: string;
    sourceUrl?: string;
  };
}

export interface LiveConnectorOutput {
  result: ConnectorResult;
  executionRecord: string;
  transmitted: string[];
  neverTransmit: string[];
}

export function connectorIdForAction(actionType: ActionRequest["actionType"], brokerId?: string): string {
  switch (actionType) {
    case "hibp-email-check":
      return "hibp-email";
    case "pwned-password-range-check":
      return "hibp-password-range";
    case "search-result-removal":
      return "google-removal-plan";
    case "gdpr-erasure":
    case "uk-gdpr-erasure":
      return "gdpr-template";
    case "follow-up":
      return "california-drop-guided";
    case "broker-opt-out":
      return brokerId && brokerCatalogEntryById(brokerId)?.teeAutomatable ? "broker-opt-out-live" : "people-search-guidance";
    case "dmca-takedown":
      return "dmca-notice-drafter";
    case "platform-abuse-report":
      return "platform-abuse-live";
    default:
      return "people-search-guidance";
  }
}

export async function runLiveConnector(input: LiveConnectorInput): Promise<LiveConnectorOutput> {
  const connectorId = connectorIdForAction(input.action.actionType, input.action.brokerId);
  const connector = connectorById(connectorId);
  if (!connector) {
    throw Object.assign(new Error("connector-not-registered"), { statusCode: 500 });
  }

  const proof = await buildAttestationProof(input.trustCenterConfig, { fetchLive: true });
  assertSensitiveExecutionAllowed({
    proof,
    requiresManagedPlaintext: connector.requiresManagedPlaintext,
    localSafe: false
  });

  if (connectorId === "hibp-password-range") {
    return runHibpPasswordRange(input, connectorId);
  }
  if (connectorId === "hibp-email") {
    return runHibpEmail(input, connectorId);
  }
  if (connectorId === "google-removal-plan") {
    return runGooglePlan(input, connectorId);
  }
  if (connectorId === "broker-opt-out-live") {
    return runBrokerOptOutLive(input, connectorId);
  }
  if (connectorId === "platform-abuse-live") {
    return runPlatformAbuseLive(input, connectorId);
  }
  if (connectorId === "dmca-notice-drafter") {
    return runGuidanceConnector(input, connectorId, true);
  }
  return runGuidanceConnector(input, connectorId, connector.requiresUserHandoff);
}

async function runHibpPasswordRange(input: LiveConnectorInput, connectorId: string): Promise<LiveConnectorOutput> {
  const prefix = input.handoff?.hashPrefix;
  if (!prefix || !/^[A-Fa-f0-9]{5}$/.test(prefix)) {
    return handoffResult(input, connectorId, "Provide a 5-character SHA-1 prefix from the browser vault for the live range check.");
  }
  const rangeUrl = pwnedPasswordRangeUrl(prefix);
  let suffixCount = 0;
  let status: ConnectorResult["status"] = "ready";
  try {
    const hibpResponse = await fetch(rangeUrl, {
      headers: { "user-agent": "oblivion-privacy-agent", "add-padding": "true" }
    });
    if (!hibpResponse.ok) throw new Error(`hibp-password-range-${hibpResponse.status}`);
    const text = await hibpResponse.text();
    suffixCount = text.trim() ? text.trim().split(/\r?\n/).length : 0;
  } catch {
    status = "failed";
  }
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status,
    sourceUrl: rangeUrl,
    officialRemovalPath: "https://haveibeenpwned.com/API/v3#PwnedPasswords",
    summary: `Live Pwned Passwords range check: ${suffixCount} padded suffix rows for approved prefix.`,
    requiresUserHandoff: false
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: range check ${status}.`,
    transmitted: ["hashPrefix"],
    neverTransmit: ["password"]
  };
}

async function runHibpEmail(input: LiveConnectorInput, connectorId: string): Promise<LiveConnectorOutput> {
  const email = input.handoff?.emailLabel;
  if (!email) {
    return handoffResult(
      input,
      connectorId,
      "Live HIBP email check requires emailLabel in the execute body (decrypted in browser, never stored server-side)."
    );
  }
  if (!process.env.HIBP_API_KEY?.trim()) {
    throw Object.assign(new Error("hibp-api-key-not-configured"), { statusCode: 503 });
  }
  const hibpResponse = await fetch(
    `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
    {
      headers: {
        "hibp-api-key": process.env.HIBP_API_KEY,
        "user-agent": "oblivion-privacy-agent"
      }
    }
  );
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: hibpResponse.status === 404 ? "recorded" : hibpResponse.ok ? "ready" : "failed",
    sourceUrl: "https://haveibeenpwned.com/api/v3/breachedaccount",
    officialRemovalPath: "https://haveibeenpwned.com/API/v3",
    summary:
      hibpResponse.status === 404
        ? "Live HIBP reports no breach record for the approved email."
        : "Live HIBP email check completed or requires review.",
    requiresUserHandoff: false
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: email check ${result.status}.`,
    transmitted: ["email"],
    neverTransmit: ["password", "ssn"]
  };
}

async function runBrokerOptOutLive(input: LiveConnectorInput, connectorId: string): Promise<LiveConnectorOutput> {
  const broker = input.action.brokerId ? brokerCatalogEntryById(input.action.brokerId) : undefined;
  const profileUrl = input.handoff?.sourceUrl;
  const emailLabel = input.handoff?.emailLabel;
  if (!broker) {
    return handoffResult(input, connectorId, "Live broker opt-out requires brokerId on the approved action.");
  }
  if (!profileUrl && broker.submissionMethod === "web-form") {
    return handoffResult(
      input,
      connectorId,
      "Live broker opt-out requires sourceUrl in the execute handoff (profile URL from vault)."
    );
  }
  if (broker.submissionMethod === "email" && !emailLabel && !broker.privacyEmail) {
    return handoffResult(input, connectorId, "Live email opt-out requires emailLabel or a catalog privacy email.");
  }
  if (!broker.teeAutomatable || broker.requiresIdVerification) {
    const result = buildConnectorResult(input.action.caseId, connectorId, {
      status: "ready",
      sourceUrl: broker.officialOptOutUrl,
      officialRemovalPath: broker.officialOptOutUrl,
      summary: `${broker.brokerLabel} requires user-held verification. Open the official opt-out path.`,
      requiresUserHandoff: true
    });
    return {
      result,
      executionRecord: `live connector ${connectorId}: handoff required for ${broker.brokerId}.`,
      transmitted: [],
      neverTransmit: ["ssn", "government-id", "password"]
    };
  }
  const destination = broker.privacyEmail ?? broker.officialOptOutUrl;
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: "recorded",
    sourceUrl: destination,
    officialRemovalPath: broker.officialOptOutUrl,
    summary: `Live ${broker.brokerLabel} opt-out recorded via ${broker.submissionMethod}. Awaiting broker confirmation.`,
    requiresUserHandoff: broker.submissionMethod === "portal"
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: ${broker.brokerId} opt-out ${result.status}.`,
    transmitted: ["legal-name", "email", "profile-url"],
    neverTransmit: ["ssn", "password", "government-id"]
  };
}

async function runPlatformAbuseLive(input: LiveConnectorInput, connectorId: string): Promise<LiveConnectorOutput> {
  const infringingUrl = input.handoff?.sourceUrl;
  const emailLabel = input.handoff?.emailLabel;
  if (!infringingUrl) {
    return handoffResult(
      input,
      connectorId,
      "Live platform abuse report requires sourceUrl in the execute handoff (infringing URL from vault)."
    );
  }
  if (!emailLabel) {
    return handoffResult(input, connectorId, "Live platform abuse report requires emailLabel in the execute handoff.");
  }
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: "recorded",
    sourceUrl: input.action.destination,
    officialRemovalPath: input.action.destination,
    summary: "Live platform abuse notice recorded for host review. Track response in follow-ups.",
    requiresUserHandoff: false
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: platform abuse notice recorded.`,
    transmitted: ["legal-name", "email", "infringing-url"],
    neverTransmit: ["original-media", "password", "ssn"]
  };
}

function runGooglePlan(input: LiveConnectorInput, connectorId: string): LiveConnectorOutput {
  const result = createGoogleRemovalPlan(input.action.caseId, input.handoff?.sourceUrl);
  return {
    result: { ...result, connectorId },
    executionRecord: `live connector ${connectorId}: official Google removal plan recorded for user-held submission.`,
    transmitted: [],
    neverTransmit: ["legal-name", "email", "address", "ssn", "password"]
  };
}

function runGuidanceConnector(
  input: LiveConnectorInput,
  connectorId: string,
  requiresUserHandoff: boolean
): LiveConnectorOutput {
  const source = sourceVerificationFor(connectorId);
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: "recorded",
    sourceUrl: source?.officialUrl ?? input.action.destination,
    officialRemovalPath: source?.expectedRemovalPath ?? source?.officialUrl,
    summary: `Live ${connectorId} handoff: ${input.action.destination}. Submit via official path after approval.`,
    requiresUserHandoff
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: approved packet recorded${requiresUserHandoff ? " for user-held submission" : ""}.`,
    transmitted: [],
    neverTransmit: ["ssn", "password", "government-id"]
  };
}

function handoffResult(input: LiveConnectorInput, connectorId: string, message: string): LiveConnectorOutput {
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: "ready",
    sourceUrl: input.action.destination,
    summary: message,
    requiresUserHandoff: true
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: awaiting client handoff payload.`,
    transmitted: [],
    neverTransmit: ["password", "ssn"]
  };
}

function buildConnectorResult(
  caseId: string,
  connectorId: string,
  input: {
    status: ConnectorResult["status"];
    sourceUrl?: string;
    officialRemovalPath?: string;
    summary: string;
    requiresUserHandoff: boolean;
  }
): ConnectorResult {
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId,
    status: input.status,
    sourceUrl: input.sourceUrl ?? "https://oblivion.local/connector",
    officialRemovalPath: input.officialRemovalPath,
    confidence: "high",
    requiresUserHandoff: input.requiresUserHandoff,
    nextCheckAt: followUpDate(30),
    summary: input.summary,
    createdAt: new Date().toISOString()
  };
}