import { createHash } from "node:crypto";
import { DomainError } from "../errors.js";
import { brokerCatalogEntryById } from "../brokerCatalog.js";
import { followUpDate } from "../deadlines.js";
import { getPreset } from "./presets.js";
import type { CaseRecord, ConnectorResult, FollowUp, PresetId } from "../types.js";

export function createScoutFindings(caseId: string, presetId: PresetId): ConnectorResult {
  const now = new Date().toISOString();
  const highRisk = presetId === "high-risk-safety";
  const connectorId = getPreset(presetId).connectorIds[0] ?? "people-search-guidance";
  const officialRemovalPath =
    presetId === "search-result-suppression"
      ? "https://support.google.com/websearch/answer/12719076"
      : presetId === "california-drop"
        ? "https://privacy.ca.gov/drop/"
        : presetId === "gdpr-erasure"
          ? "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/"
          : presetId === "breach-exposure"
            ? "https://haveibeenpwned.com/API/v3"
            : presetId === "content-takedown"
              ? "https://www.copyright.gov/dmca/"
              : "https://www.consumer.ftc.gov/articles/what-know-about-people-search-sites";
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId,
    status: "ready",
    sourceUrl: officialRemovalPath,
    officialRemovalPath,
    confidence: highRisk ? "medium" : "high",
    requiresUserHandoff: highRisk || presetId === "search-result-suppression",
    nextCheckAt: followUpDate(highRisk ? 3 : 14),
    summary:
      presetId === "content-takedown"
        ? "Scout mapped DMCA notice drafting and host abuse contacts for confirmed infringing URLs."
        : highRisk
          ? "High-risk scout result from official guidance sources. Confirm match before drafting."
          : "Scout result mapped to official removal guidance for this route.",
    createdAt: now
  };
}

export function createGoogleRemovalPlan(caseId: string, sourceUrl?: string): ConnectorResult {
  const now = new Date().toISOString();
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "google-removal-plan",
    status: "planned",
    sourceUrl: sourceUrl || "https://support.google.com/websearch/answer/12719076",
    officialRemovalPath: "https://support.google.com/websearch/answer/12719076",
    confidence: "high",
    requiresUserHandoff: true,
    nextCheckAt: followUpDate(7),
    summary:
      "Google plan separates source-page deletion from search-result suppression. Logged-in submission remains a user handoff.",
    createdAt: now
  };
}

export function createDropPlan(caseRecord: CaseRecord): ConnectorResult {
  const now = new Date().toISOString();
  if (caseRecord.jurisdiction !== "US") {
    throw new DomainError("drop-california-residency-required", 422);
  }
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId: caseRecord.id,
    connectorId: "california-drop-guided",
    status: "planned",
    sourceUrl: "https://privacy.ca.gov/drop/",
    officialRemovalPath: "https://privacy.ca.gov/drop/",
    confidence: "high",
    requiresUserHandoff: true,
    nextCheckAt: followUpDate(90),
    summary:
      "DROP is a California-resident official flow. Oblivion can guide and track it, but the user should complete the government submission.",
    createdAt: now
  };
}

export function createPlanFollowUp(caseId: string, presetId: PresetId): FollowUp {
  return {
    id: `followup_${crypto.randomUUID()}`,
    caseId,
    dueDate: followUpDate(presetId === "california-drop" ? 90 : presetId === "content-takedown" ? 7 : 14),
    expectedResponseWindow:
      presetId === "california-drop"
        ? "Track official 90-day broker processing window."
        : presetId === "content-takedown"
          ? "Track host or platform response to the approved takedown notice."
          : "Recheck source after expected response window.",
    escalationPath:
      presetId === "gdpr-erasure"
        ? "Prepare regulator escalation draft if no lawful response."
        : presetId === "content-takedown"
          ? "Prepare counter-notice review notes or escalate to platform trust and safety."
          : "Prepare follow-up request or source recheck."
  };
}

export function createBrokerFollowUps(
  caseId: string,
  exposures: Array<{ id: string; brokerId?: string; brokerLabel?: string }>
): FollowUp[] {
  const followUps: FollowUp[] = [];
  for (const exposure of exposures) {
    if (!exposure.brokerId) continue;
    const catalog = brokerCatalogEntryById(exposure.brokerId);
    followUps.push({
      id: `followup_${crypto.randomUUID()}`,
      caseId,
      brokerId: exposure.brokerId,
      brokerLabel: exposure.brokerLabel ?? catalog?.brokerLabel,
      exposureId: exposure.id,
      dueDate: followUpDate(catalog?.recheckDays ?? 14),
      expectedResponseWindow: `Recheck ${catalog?.brokerLabel ?? "broker"} listing after opt-out submission.`,
      escalationPath: catalog?.requiresIdVerification
        ? "Broker may require ID verification — complete user-held steps if listing remains."
        : "Prepare follow-up opt-out or broker sweep recheck."
    });
  }
  return followUps;
}

export function createContentAbusePathPlan(caseId: string, urlCount: number): ConnectorResult {
  const now = new Date().toISOString();
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "platform-abuse-handoff",
    status: "ready",
    sourceUrl: "https://www.copyright.gov/dmca/",
    officialRemovalPath: "https://www.copyright.gov/dmca/",
    confidence: "high",
    requiresUserHandoff: true,
    nextCheckAt: followUpDate(14),
    summary: `Host abuse contacts prepared for ${urlCount} confirmed infringing URL(s).`,
    createdAt: now
  };
}

export function createBrokerRemovalPathPlan(caseId: string, brokerCount: number): ConnectorResult {
  const now = new Date().toISOString();
  return {
    id: `connector_${crypto.randomUUID()}`,
    caseId,
    connectorId: "broker-registry-sweep",
    status: "ready",
    sourceUrl: "https://www.consumer.ftc.gov/articles/what-know-about-people-search-sites",
    officialRemovalPath: "https://www.consumer.ftc.gov/articles/what-know-about-people-search-sites",
    confidence: "high",
    requiresUserHandoff: false,
    nextCheckAt: followUpDate(14),
    summary: `Verified official opt-out paths for ${brokerCount} confirmed broker listing(s).`,
    createdAt: now
  };
}

export function pwnedPasswordRangeUrl(hashPrefix: string): string {
  return `https://api.pwnedpasswords.com/range/${hashPrefix.toUpperCase()}`;
}

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex").toUpperCase();
}