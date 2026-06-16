import { DomainError } from "./errors.js";
import type { TrustCenterConfig } from "./attestation.js";
import { buildAttestationProof } from "./attestation.js";
import { isBrokerEmailConfigured, sendBrokerOptOutEmail } from "./brokerMailer.js";
import {
  isPlatformAbuseEmailConfigured,
  resolveHostAbuseContact,
  sendPlatformAbuseNotice
} from "./platformAbuse.js";
import { brokerCatalogEntryById } from "./brokerCatalog.js";
import { connectorById } from "./connectors.js";
import { createGoogleRemovalPlan } from "./cleanup.js";
import {
  buildHibpEmailConnectorResult,
  buildHibpPasswordRangeConnectorResult,
  fetchHibpEmailBreach,
  fetchHibpPasswordRange
} from "./connectors/hibp.js";
import { followUpDate } from "./deadlines.js";
import { assertSensitiveExecutionAllowed } from "./runtimeGuard.js";
import { sourceVerificationFor } from "./sourceVerification.js";
import { buildDraftText } from "./templates.js";
import { brokerWebFormAutomationEnabled, probeBrokerOptOutForm } from "./brokerWebForm.js";
import { probeOfficialUrl } from "./urlProbe.js";
import {
  assertCreditsForEmailRelay,
  debitCreditsForEmailRelay,
  EMAIL_RELAY_CREDITS
} from "./credits.js";
import { buildEmailHandoff, operatorEmailRelayEnabled } from "./emailHandoff.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { ActionRequest, Approval, ConnectorResult } from "./types.js";

export interface LiveConnectorInput {
  action: ActionRequest;
  approval: Approval;
  trustCenterConfig: TrustCenterConfig;
  store?: MemoryStore;
  walletAddress?: string;
  operatorEmailRelay?: boolean;
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
    throw new DomainError("connector-not-registered", 500);
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
    return runDraftConnector(input, connectorId, true);
  }
  if (connectorId === "gdpr-template") {
    return runDraftConnector(input, connectorId, true);
  }
  return runGuidanceConnector(input, connectorId, connector.requiresUserHandoff);
}

async function runHibpPasswordRange(input: LiveConnectorInput, connectorId: string): Promise<LiveConnectorOutput> {
  const prefix = input.handoff?.hashPrefix;
  if (!prefix || !/^[A-Fa-f0-9]{5}$/.test(prefix)) {
    return handoffResult(input, connectorId, "Provide a 5-character SHA-1 prefix from the browser vault for the live range check.");
  }
  const range = await fetchHibpPasswordRange(prefix);
  const result = buildHibpPasswordRangeConnectorResult(input.action.caseId, prefix, range);
  return {
    result,
    executionRecord: `live connector ${connectorId}: range check ${result.status}.`,
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
  const hibpResponse = await fetchHibpEmailBreach(email);
  const result = buildHibpEmailConnectorResult(input.action.caseId, hibpResponse);
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
  const probe = await probeOfficialUrl(broker.officialOptOutUrl);
  const reachability = probe.reachable
    ? `Official opt-out path reachable (${probe.status ?? "ok"}).`
    : "Official opt-out path could not be verified — open the catalog URL manually.";

  if (broker.submissionMethod === "web-form") {
    const formProbe = await probeBrokerOptOutForm(broker.officialOptOutUrl);
    const automationReady =
      brokerWebFormAutomationEnabled() &&
      formProbe.reachable &&
      formProbe.formCount > 0 &&
      !formProbe.requiresCaptcha;
    const result = buildConnectorResult(input.action.caseId, connectorId, {
      status: formProbe.reachable ? "recorded" : "ready",
      sourceUrl: broker.officialOptOutUrl,
      officialRemovalPath: broker.officialOptOutUrl,
      summary: `${formProbe.summary} ${reachability}${
        automationReady
          ? " Form mapped for TEE handoff packet — user confirmation still required before any submit."
          : " User-held browser submission required."
      }`,
      requiresUserHandoff: !automationReady
    });
    return {
      result,
      executionRecord: `live connector ${connectorId}: ${broker.brokerId} web-form ${automationReady ? "mapped" : "handoff"}.`,
      transmitted: automationReady ? ["profile-url"] : [],
      neverTransmit: ["ssn", "password", "government-id"]
    };
  }

  if (broker.submissionMethod === "email" && broker.privacyEmail && emailLabel) {
    const relayDecision = resolveEmailRelayPath(input);
    if (relayDecision.mode === "handoff") {
      const handoff = buildEmailHandoff({
        action: input.action,
        approval: input.approval,
        to: broker.privacyEmail,
        replyTo: emailLabel
      });
      const result = buildConnectorResult(input.action.caseId, connectorId, {
        status: "ready",
        sourceUrl: broker.privacyEmail,
        officialRemovalPath: broker.officialOptOutUrl,
        summary: `${relayDecision.reason} Open your email app to send the approved draft.`,
        requiresUserHandoff: true,
        mailtoUrl: handoff.mailtoUrl
      });
      return {
        result,
        executionRecord: `live connector ${connectorId}: ${broker.brokerId} mailto handoff.`,
        transmitted: [],
        neverTransmit: ["ssn", "password", "government-id"]
      };
    }
    if (relayDecision.mode === "insufficient-credits") {
      throw new DomainError("credits-insufficient", 402, {
        requiredCredits: EMAIL_RELAY_CREDITS
      });
    }
    const mailed = await sendBrokerOptOutEmail({
      brokerLabel: broker.brokerLabel,
      to: broker.privacyEmail,
      replyTo: emailLabel,
      profileUrl,
      purpose: input.approval.purpose
    });
    if (mailed.ok && input.store && input.walletAddress) {
      debitCreditsForEmailRelay(input.store, input.walletAddress, input.action.caseId);
    }
    const result = buildConnectorResult(input.action.caseId, connectorId, {
      status: mailed.ok ? "recorded" : "failed",
      sourceUrl: broker.privacyEmail,
      officialRemovalPath: broker.officialOptOutUrl,
      summary: mailed.ok
        ? `Live ${broker.brokerLabel} opt-out email sent via ${mailed.provider} (${EMAIL_RELAY_CREDITS} credits). ${reachability}`
        : `Live ${broker.brokerLabel} email opt-out failed (${mailed.error ?? "unknown"}). Open the official path manually.`,
      requiresUserHandoff: !mailed.ok
    });
    return {
      result,
      executionRecord: `live connector ${connectorId}: ${broker.brokerId} email opt-out ${result.status}.`,
      transmitted: ["legal-name", "email", "profile-url"],
      neverTransmit: ["ssn", "password", "government-id"]
    };
  }

  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: probe.reachable ? "recorded" : "ready",
    sourceUrl: destination,
    officialRemovalPath: broker.officialOptOutUrl,
    summary: `Live ${broker.brokerLabel} opt-out via ${broker.submissionMethod}. ${reachability}`,
    requiresUserHandoff:
      broker.submissionMethod === "portal" ||
      broker.submissionMethod === "email" ||
      !probe.reachable
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
  const contact = resolveHostAbuseContact(input.action.destination, infringingUrl);
  if (!contact) {
    return handoffResult(input, connectorId, "Live platform abuse report requires a resolvable host destination.");
  }
  const probe = await probeOfficialUrl(infringingUrl);
  const hostReachable = probe.reachable
    ? `Infringing URL reachable (${probe.status ?? "ok"}).`
    : "Infringing URL could not be verified — confirm the link before host contact.";
  const officialPath = contact.channel ?? `mailto:${contact.email}`;

  const relayDecision = resolveEmailRelayPath(input);
  if (relayDecision.mode === "handoff" || !isPlatformAbuseEmailConfigured()) {
    const handoff = buildEmailHandoff({
      action: input.action,
      approval: input.approval,
      to: contact.email,
      replyTo: emailLabel,
      subject: `Abuse report: ${contact.host}`
    });
    const result = buildConnectorResult(input.action.caseId, connectorId, {
      status: "ready",
      sourceUrl: officialPath,
      officialRemovalPath: officialPath,
      summary: `${relayDecision.reason} Abuse contact: ${contact.email}${contact.inferred ? " (inferred)" : ""}. ${hostReachable}`,
      requiresUserHandoff: true,
      mailtoUrl: handoff.mailtoUrl
    });
    return {
      result,
      executionRecord: `live connector ${connectorId}: platform abuse mailto handoff for ${contact.host}.`,
      transmitted: [],
      neverTransmit: ["original-media", "password", "ssn"]
    };
  }
  if (relayDecision.mode === "insufficient-credits") {
    throw new DomainError("credits-insufficient", 402, {
      requiredCredits: EMAIL_RELAY_CREDITS
    });
  }
  const mailed = await sendPlatformAbuseNotice({
    action: input.action,
    approval: input.approval,
    contact,
    infringingUrl,
    emailLabel
  });
  if (mailed.ok && input.store && input.walletAddress) {
    debitCreditsForEmailRelay(input.store, input.walletAddress, input.action.caseId);
  }
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: mailed.ok ? "recorded" : "failed",
    sourceUrl: officialPath,
    officialRemovalPath: officialPath,
    summary: mailed.ok
      ? `Live abuse notice sent to ${contact.email} for ${contact.host} via ${mailed.provider} (${EMAIL_RELAY_CREDITS} credits). ${hostReachable}`
      : `Live abuse notice to ${contact.email} failed (${mailed.error ?? "unknown"}). ${hostReachable}`,
    requiresUserHandoff: !mailed.ok
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: platform abuse email ${result.status} for ${contact.host}.`,
    transmitted: ["legal-name", "email", "infringing-url"],
    neverTransmit: ["original-media", "password", "ssn"]
  };
}

function resolveEmailRelayPath(input: LiveConnectorInput): {
  mode: "relay" | "handoff" | "insufficient-credits";
  reason: string;
} {
  const caseRelay = input.operatorEmailRelay !== false;
  if (!caseRelay) {
    return { mode: "handoff", reason: "Operator email relay is off for this case." };
  }
  if (!operatorEmailRelayEnabled()) {
    return { mode: "handoff", reason: "Operator email relay is disabled in this deployment." };
  }
  if (!isBrokerEmailConfigured()) {
    return { mode: "handoff", reason: "Operator mail relay is not configured." };
  }
  if (!input.walletAddress || !input.store) {
    return { mode: "handoff", reason: "Wallet address required for operator relay — using mailto handoff." };
  }
  try {
    assertCreditsForEmailRelay(input.store, input.walletAddress);
    return { mode: "relay", reason: "" };
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "credits-insufficient") {
      return { mode: "insufficient-credits", reason: "Insufficient credits for operator email relay." };
    }
    throw error;
  }
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

function runDraftConnector(
  input: LiveConnectorInput,
  connectorId: string,
  requiresUserHandoff: boolean
): LiveConnectorOutput {
  const source = sourceVerificationFor(connectorId);
  const draftText =
    input.action.draftText ||
    buildDraftText({
      actionType: input.action.actionType,
      jurisdiction: "US",
      destination: input.action.destination,
      purpose: input.approval.purpose
    });
  const result = buildConnectorResult(input.action.caseId, connectorId, {
    status: "recorded",
    sourceUrl: source?.officialUrl ?? input.action.destination,
    officialRemovalPath: source?.expectedRemovalPath ?? source?.officialUrl,
    summary: `Live ${connectorId}: draft ready for ${input.action.destination}. ${draftText.split("\n").slice(0, 3).join(" ")}`,
    requiresUserHandoff
  });
  return {
    result,
    executionRecord: `live connector ${connectorId}: statutory draft recorded for user-held submission.`,
    transmitted: [],
    neverTransmit: ["ssn", "password", "government-id"]
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
    mailtoUrl?: string;
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
    mailtoUrl: input.mailtoUrl,
    nextCheckAt: followUpDate(30),
    summary: input.summary,
    createdAt: new Date().toISOString()
  };
}