import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrustCenterConfig } from "../../domain/attestation.js";
import { buildAttestationProof } from "../../domain/attestation.js";
import { connectorById } from "../../domain/connectors.js";
import { createGoogleRemovalPlan } from "../../domain/cleanup.js";
import {
  buildHibpEmailConnectorResult,
  buildHibpPasswordRangeConnectorResult,
  fetchHibpEmailBreach,
  fetchHibpPasswordRange
} from "../../domain/connectors/hibp.js";
import { canExecuteWithApproval } from "../../domain/policy.js";
import { assertSensitiveExecutionAllowed } from "../../domain/runtimeGuard.js";
import { sourceVerificationFor } from "../../domain/sourceVerification.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { getCaseWithAccess } from "../auth.js";
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
  approvalId?: string;
}

interface GoogleRemovalPlanBody {
  caseId: string;
  sourceUrl?: string;
}

export async function handleConnectorRoutes(context: ConnectorRouteContext): Promise<boolean> {
  const { method, url, request, response, store } = context;

  if (method === "POST" && url.pathname === "/api/connectors/hibp/password-range") {
    const body = await readJson<HibpPasswordRangeBody>(request);
    const caseRecord = getCaseWithAccess(context.request, store, body.caseId);
    const approval = body.approvalId ? store.approvals.get(body.approvalId) : null;
    if (!approval || approval.caseId !== caseRecord.id || approval.actionType !== "pwned-password-range-check") {
      throw new HttpError(403, "hibp-password-range-approval-required");
    }
    const decision = canExecuteWithApproval(approval);
    if (!decision.allowed) throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
    if (!/^[A-Fa-f0-9]{5}$/.test(body.hashPrefix)) {
      throw new HttpError(422, "sha1-hash-prefix-required");
    }
    const range = await fetchHibpPasswordRange(body.hashPrefix);
    const result = buildHibpPasswordRangeConnectorResult(caseRecord.id, body.hashPrefix, range);
    recordSourceCheck(store, caseRecord.id, "hibp-password-range");
    store.connectorResults.set(result.id, result);
    approval.status = "used";
    sendJson(response, 200, { result, transmitted: ["hashPrefix"], neverTransmit: ["password"] });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/hibp/email-check") {
    const body = await readJson<HibpEmailBody>(request);
    const caseRecord = getCaseWithAccess(context.request, store, body.caseId);
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
    const email = body.emailLabel;
    if (!email) throw new HttpError(422, "email-label-required");
    const hibpResponse = await fetchHibpEmailBreach(email);
    const result = buildHibpEmailConnectorResult(caseRecord.id, hibpResponse);
    recordSourceCheck(store, caseRecord.id, "hibp-email");
    store.connectorResults.set(result.id, result);
    approval.status = "used";
    sendJson(response, 200, { result });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/google/removal-plan") {
    const body = await readJson<GoogleRemovalPlanBody>(request);
    const caseRecord = getCaseWithAccess(context.request, store, body.caseId);
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

