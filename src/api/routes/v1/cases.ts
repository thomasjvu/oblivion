import type { IncomingMessage, ServerResponse } from "node:http";
import { assertPartnerOwnsCase } from "../../auth.js";
import { handleAgentRun } from "../../handlers/agentRun.js";
import {
  handleApplyPreset,
  handleApprove,
  handleCaseDiscover,
  handleCaseIntake,
  handleExecute,
  handleFindingDecision,
  type ApplyPresetBody,
  type IntakeBody
} from "../../handlers/caseHandlers.js";
import { deleteCaseRecord } from "../../handlers/caseLifecycle.js";
import { buildAgentPlanView } from "../../../domain/cleanup.js";
import { createCaseRecord } from "../../../domain/cases.js";
import { findPartnerCaseByExternalRef, runPartnerAgentUntilBlocked } from "../../../domain/partnerAgent.js";
import { buildPartnerCaseExport, recordPartnerDataAccess } from "../../../domain/partnerAudit.js";
import { meterPartnerUsage } from "../../../domain/partnerBilling.js";
import { partnerPresetAllowlist } from "../../../domain/partners.js";
import { redactedActionForExport } from "../../../domain/exportPrivacy.js";
import { buildPartnerCaseStatus, buildPartnerRiskSummary } from "../../../domain/partnerStatus.js";
import { withPartnerCase } from "../../handlers/caseRouteAdapters.js";
import { buildStatus } from "../../../domain/status.js";
import { emitCaseWebhook } from "../../../domain/webhooks.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import { type CreateV1CaseBody, summarizePartnerCase, type V1PartnerContext } from "./context.js";

export async function handleV1CaseRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1PartnerContext
): Promise<boolean> {
  const { store, partner, trustCenterPath, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/cases") {
    const body = await readJson<CreateV1CaseBody>(request);
    if (body.externalRef) {
      const existing = findPartnerCaseByExternalRef(store, partner.id, body.externalRef);
      if (existing) {
        sendJson(response, 200, {
          case: summarizePartnerCase(existing),
          status: buildPartnerCaseStatus(store, existing.id),
          idempotent: true
        });
        return true;
      }
    }
    meterPartnerUsage(store, partner, "case");
    const { caseRecord } = createCaseRecord({
      ...body,
      partnerId: partner.id
    });
    store.cases.set(caseRecord.id, caseRecord);
    await emitCaseWebhook(store, caseRecord.id, "case.created", {
      externalRef: caseRecord.externalRef,
      jurisdiction: caseRecord.jurisdiction
    });
    sendJson(response, 201, {
      case: summarizePartnerCase(caseRecord),
      status: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/cases") {
    const externalRef = url.searchParams.get("externalRef") ?? undefined;
    let cases = store.casesForPartner(partner.id);
    if (externalRef) cases = cases.filter((item) => item.externalRef === externalRef);
    sendJson(response, 200, {
      cases: cases.map((caseRecord) => ({
        ...summarizePartnerCase(caseRecord),
        status: buildPartnerCaseStatus(store, caseRecord.id)
      }))
    });
    return true;
  }

  const caseReadMatch = pathname.match(/^\/v1\/cases\/([^/]+)$/);
  if (method === "GET" && caseReadMatch) {
    const caseRecord = store.getCaseOrThrow(caseReadMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, {
      case: summarizePartnerCase(caseRecord),
      status: buildStatus(store, caseRecord.id),
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const intakeMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/intake$/);
  if (method === "POST" && intakeMatch) {
    const body = await readJson<IntakeBody>(request);
    const result = await withPartnerCase(partner, store, intakeMatch[1], (caseRecord) => {
      handleCaseIntake(store, caseRecord, body);
      return { case: summarizePartnerCase(caseRecord), status: buildStatus(store, caseRecord.id) };
    });
    sendJson(response, 200, result);
    return true;
  }

  const presetMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/preset$/);
  if (method === "POST" && presetMatch) {
    const body = await readJson<ApplyPresetBody>(request);
    const allowlist = partnerPresetAllowlist();
    if (!allowlist.has(body.presetId)) throw new HttpError(422, "preset-not-available-for-partners");
    const caseRecord = store.getCaseOrThrow(presetMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const { preset, plan } = await handleApplyPreset(store, caseRecord, body, { emitWebhook: true });
    sendJson(response, 201, {
      preset,
      plan,
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const planMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/plan$/);
  if (method === "GET" && planMatch) {
    const caseRecord = store.getCaseOrThrow(planMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const plan = store.agentPlanForCase(caseRecord.id);
    sendJson(response, 200, {
      plan: plan ? buildAgentPlanView(plan) : null,
      connectorResults: store.connectorResultsForCase(caseRecord.id),
      timeline: store.agentTimelineForCase(caseRecord.id)
    });
    return true;
  }

  const runMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/run$/);
  if (method === "POST" && runMatch) {
    const caseRecord = store.getCaseOrThrow(runMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const result = await handleAgentRun(store, caseRecord, trustCenterPath, { highAutonomy: false });
    sendJson(response, 200, result);
    return true;
  }

  const runUntilMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/run-until-blocked$/);
  if (method === "POST" && runUntilMatch) {
    const caseRecord = store.getCaseOrThrow(runUntilMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const body = await readJson<{ maxIterations?: number }>(request);
    const result = await runPartnerAgentUntilBlocked({
      store,
      caseRecord,
      trustCenterConfig: loadTrustCenterConfig,
      maxIterations: body.maxIterations
    });
    sendJson(response, 200, result);
    return true;
  }

  const exportMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/export$/);
  if (method === "GET" && exportMatch) {
    const caseRecord = store.getCaseOrThrow(exportMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    recordPartnerDataAccess(store, {
      partnerId: partner.id,
      caseId: caseRecord.id,
      action: "export",
      source: "v1"
    });
    sendJson(response, 200, buildPartnerCaseExport(store, caseRecord));
    return true;
  }

  const deleteMatch = pathname.match(/^\/v1\/cases\/([^/]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const caseRecord = store.getCaseOrThrow(deleteMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const result = await deleteCaseRecord(store, caseRecord, {
      partner,
      emitWebhook: true,
      auditSource: "v1"
    });
    sendJson(response, 200, result);
    return true;
  }

  const statusMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/status$/);
  if (method === "GET" && statusMatch) {
    const caseRecord = store.getCaseOrThrow(statusMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, buildPartnerCaseStatus(store, caseRecord.id));
    return true;
  }

  const riskMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/risk-summary$/);
  if (method === "GET" && riskMatch) {
    const caseRecord = store.getCaseOrThrow(riskMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, buildPartnerRiskSummary(store, caseRecord.id));
    return true;
  }

  const timelineMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/timeline$/);
  if (method === "GET" && timelineMatch) {
    const caseRecord = store.getCaseOrThrow(timelineMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, { timeline: store.agentTimelineForCase(caseRecord.id) });
    return true;
  }

  const exposuresMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/exposures$/);
  if (method === "GET" && exposuresMatch) {
    const caseRecord = store.getCaseOrThrow(exposuresMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const status = buildStatus(store, caseRecord.id);
    sendJson(response, 200, {
      exposures: status.findings,
      pending: status.pendingFindings,
      confirmed: status.confirmedFindings
    });
    return true;
  }

  const discoverMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/discover$/);
  if (method === "POST" && discoverMatch) {
    meterPartnerUsage(store, partner, "discover", discoverMatch[1]);
    const body = await readJson<{ pastedUrls?: string[] }>(request);
    const result = await withPartnerCase(partner, store, discoverMatch[1], async (caseRecord) => {
      const plan = store.agentPlanForCase(caseRecord.id);
      const { discovered, discovery, discoveryPlan } = await handleCaseDiscover(
        store,
        caseRecord,
        body,
        plan?.presetId
      );
      return { discovered, discovery, discoveryPlan };
    });
    sendJson(response, 201, result);
    return true;
  }

  const exposureDecisionMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/exposures\/([^/]+)\/(confirm|reject)$/);
  if (method === "POST" && exposureDecisionMatch) {
    const decision = exposureDecisionMatch[3] === "confirm" ? "confirmed" : "rejected";
    const result = await withPartnerCase(partner, store, exposureDecisionMatch[1], (caseRecord) => {
      const { exposure } = handleFindingDecision(store, caseRecord, exposureDecisionMatch[2], decision, {
        notFoundError: "exposure-not-found",
        createTimeline: false
      });
      return { exposure };
    });
    sendJson(response, 200, result);
    return true;
  }

  const approvalsMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/approvals$/);
  if (method === "GET" && approvalsMatch) {
    const caseRecord = store.getCaseOrThrow(approvalsMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const approvals = store.approvalsForCase(caseRecord.id);
    sendJson(response, 200, {
      pending: approvals.filter((approval) => approval.status === "pending"),
      history: approvals.filter((approval) => approval.status !== "pending"),
      actions: store.actionsForCase(caseRecord.id).map(redactedActionForExport)
    });
    return true;
  }

  const approveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const approval = store.approvals.get(approveMatch[1]);
    if (!approval) throw new HttpError(404, "approval-not-found");
    const body = await readJson<{ userConfirmation: string }>(request);
    const result = await withPartnerCase(partner, store, approval.caseId, async () => {
      const { approval: approvedApproval } = await handleApprove(store, approveMatch[1], body);
      return { approval: approvedApproval };
    });
    sendJson(response, 200, result);
    return true;
  }

  const executeMatch = pathname.match(/^\/v1\/actions\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const action = store.actions.get(executeMatch[1]);
    if (!action) throw new HttpError(404, "action-not-found");
    const body = await readJson<{ hashPrefix?: string; emailLabel?: string; sourceUrl?: string }>(request);
    const result = await withPartnerCase(partner, store, action.caseId, async (caseRecord) => {
      const { action: executedAction, executed } = await handleExecute(
        store,
        executeMatch[1],
        body,
        loadTrustCenterConfig
      );
      meterPartnerUsage(store, partner, "execute", caseRecord.id);
      return {
        action: executedAction,
        executorMode: executed.mode,
        connectorResult: executed.connectorResult
      };
    });
    sendJson(response, 200, result);
    return true;
  }

  const actionsMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/actions$/);
  if (method === "GET" && actionsMatch) {
    const caseRecord = store.getCaseOrThrow(actionsMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, {
      actions: store.actionsForCase(caseRecord.id).map(redactedActionForExport)
    });
    return true;
  }

  return false;
}