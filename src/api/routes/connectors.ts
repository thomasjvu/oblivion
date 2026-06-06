import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrustCenterConfig } from "../../domain/attestation.js";
import { buildAttestationProof } from "../../domain/attestation.js";
import { connectorById } from "../../domain/connectors.js";
import { createGoogleRemovalPlan, pwnedPasswordRangeUrl } from "../../domain/cleanup.js";
import { followUpDate } from "../../domain/deadlines.js";
import { canExecuteWithApproval } from "../../domain/policy.js";
import { assertSensitiveExecutionAllowed } from "../../domain/runtimeGuard.js";
import { sourceVerificationFor } from "../../domain/sourceVerification.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { HttpError } from "../errors.js";
import { readJson, sendJson } from "../http.js";

interface ConnectorRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  url: URL;
  store: MemoryStore;
  trustCenterConfig: () => Promise<TrustCenterConfig>;
}

interface HibpEmailBody {
  caseId: string;
  approvalId?: string;
  emailLabel?: string;
}

interface HibpPasswordRangeBody {
  caseId: string;
  hashPrefix: string;
}

interface GoogleRemovalPlanBody {
  caseId: string;
  sourceUrl?: string;
}

export async function handleConnectorRoutes(context: ConnectorRouteContext): Promise<boolean> {
  const { method, url, request, response, store } = context;

  if (method === "POST" && url.pathname === "/api/connectors/hibp/password-range") {
    const body = await readJson<HibpPasswordRangeBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    if (!/^[A-Fa-f0-9]{5}$/.test(body.hashPrefix)) {
      throw new HttpError(422, "sha1-hash-prefix-required");
    }
    const rangeUrl = pwnedPasswordRangeUrl(body.hashPrefix);
    let suffixCount = 0;
    let status: "ready" | "failed" = "ready";
    try {
      const hibpResponse = await fetch(rangeUrl, {
        headers: {
          "user-agent": "oblivion-privacy-agent",
          "add-padding": "true"
        }
      });
      if (!hibpResponse.ok) throw new Error(`hibp-password-range-${hibpResponse.status}`);
      const text = await hibpResponse.text();
      suffixCount = text.trim() ? text.trim().split(/\r?\n/).length : 0;
    } catch {
      status = "failed";
    }
    const result = {
      id: `connector_${crypto.randomUUID()}`,
      caseId: caseRecord.id,
      connectorId: "hibp-password-range",
      status,
      sourceUrl: rangeUrl,
      officialRemovalPath: "https://haveibeenpwned.com/API/v3#PwnedPasswords",
      confidence: "high" as const,
      requiresUserHandoff: false,
      nextCheckAt: followUpDate(30),
      summary: `Pwned Passwords range checked with only a SHA-1 prefix; ${suffixCount} padded suffix rows returned.`,
      createdAt: new Date().toISOString()
    };
    recordSourceCheck(store, caseRecord.id, "hibp-password-range");
    store.connectorResults.set(result.id, result);
    sendJson(response, 200, { result, transmitted: ["hashPrefix"], neverTransmit: ["password"] });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/hibp/email-check") {
    const body = await readJson<HibpEmailBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    const approval = body.approvalId ? store.approvals.get(body.approvalId) : null;
    if (!approval || approval.caseId !== caseRecord.id || approval.actionType !== "hibp-email-check") {
      throw new HttpError(403, "hibp-email-approval-required");
    }
    const decision = canExecuteWithApproval(approval);
    if (!decision.allowed) throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
    const connector = connectorById("hibp-email");
    if (!connector) throw new HttpError(500, "connector-not-registered");
    const proof = await buildAttestationProof(await context.trustCenterConfig(), { fetchLive: true });
    assertSensitiveExecutionAllowed({
      proof,
      requiresManagedPlaintext: connector.requiresManagedPlaintext,
      localSafe: false
    });
    if (!process.env.HIBP_API_KEY) throw new HttpError(503, "hibp-api-key-not-configured");
    const email = body.emailLabel;
    if (!email) throw new HttpError(422, "email-label-required");
    const hibpResponse = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`, {
      headers: {
        "hibp-api-key": process.env.HIBP_API_KEY,
        "user-agent": "oblivion-privacy-agent"
      }
    });
    const result = {
      id: `connector_${crypto.randomUUID()}`,
      caseId: caseRecord.id,
      connectorId: "hibp-email",
      status: hibpResponse.status === 404 ? "recorded" as const : hibpResponse.ok ? "ready" as const : "failed" as const,
      sourceUrl: "https://haveibeenpwned.com/api/v3/breachedaccount",
      officialRemovalPath: "https://haveibeenpwned.com/API/v3",
      confidence: "high" as const,
      requiresUserHandoff: false,
      nextCheckAt: followUpDate(30),
      summary: hibpResponse.status === 404 ? "HIBP reports no breach record for the approved email." : "HIBP email check completed or requires review.",
      createdAt: new Date().toISOString()
    };
    recordSourceCheck(store, caseRecord.id, "hibp-email");
    store.connectorResults.set(result.id, result);
    sendJson(response, 200, { result });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/google/removal-plan") {
    const body = await readJson<GoogleRemovalPlanBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    const result = createGoogleRemovalPlan(caseRecord.id, body.sourceUrl);
    recordSourceCheck(store, caseRecord.id, "google-removal-plan");
    store.connectorResults.set(result.id, result);
    sendJson(response, 201, { result });
    return true;
  }

  return false;
}

function recordSourceCheck(store: MemoryStore, caseId: string, connectorId: string): void {
  const sourceVerification = sourceVerificationFor(connectorId);
  if (!sourceVerification) return;
  const id = `source_${crypto.randomUUID()}`;
  store.sourceChecks.set(id, {
    id,
    caseId,
    officialUrl: sourceVerification.officialUrl,
    checkedAt: sourceVerification.checkedAt,
    claimVerified: sourceVerification.claimVerified,
    operatorVersion: sourceVerification.operatorVersion
  });
}

