import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAgentRun } from "../../handlers/agentRun.js";
import {
  handleApplyPreset,
  handleApprove,
  handleCaseDiscover,
  handleCaseIntake,
  handleExecute,
  handleFindingDecision,
  type IntakeBody
} from "../../handlers/caseHandlers.js";
import { buildAgentPlanView, CLEANUP_PRESETS, presetUsesBrokerDiscovery, presetUsesContentDiscovery } from "../../../domain/cleanup.js";
import { createTimelineEvent } from "../../../domain/agentTimeline.js";
import { buildStatus, proposeApprovedAction } from "../../../domain/orchestration.js";
import { describeDiscoveryPlan, discoveryReadinessMessage } from "../../../domain/exposureDiscovery.js";
import {
  assertCreditsForDiscovery,
  creditsBypassEnabled,
  debitCreditsForDiscovery,
  discoveryCredits,
  resolveCreditsView
} from "../../../domain/credits.js";
import { sanitizeForLog } from "../../../domain/safeLogging.js";
import {
  assertCaseActivated,
  autoActivateCaseForSubscriptionWallet
} from "../../../domain/caseActivation.js";
import { walletAddressForCase } from "../../../domain/walletCases.js";
import { createCaseRecord, publicCaseView } from "../../../domain/cases.js";
import { emitApprovalPendingWebhook } from "../../../domain/webhooks.js";
import type { AutonomyMode, PresetId } from "../../../domain/types.js";
import { getCaseWithAccess } from "../../auth.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import type { CaseAgentRunBody, ConsumerContext, CreateCaseBody, ProposeActionBody } from "./context.js";

export async function handleConsumerCaseRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store, trustCenterPath, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/cases") {
    throw new HttpError(401, "case-list-not-available");
  }

  if (method === "POST" && url.pathname === "/api/cases") {
    const body = await readJson<CreateCaseBody>(request);
    const { caseRecord, accessToken } = createCaseRecord(body);
    store.cases.set(caseRecord.id, caseRecord);
    sendJson(response, 201, {
      case: publicCaseView(caseRecord),
      accessToken,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const caseReadMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (method === "GET" && caseReadMatch) {
    const caseRecord = getCaseWithAccess(request, store, caseReadMatch[1]);
    sendJson(response, 200, {
      case: publicCaseView(caseRecord),
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const presetMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/preset$/);
  if (method === "POST" && presetMatch) {
    const body = await readJson<{ presetId: PresetId; autonomyMode?: AutonomyMode; walletAddress?: string }>(
      request
    );
    let caseRecord = getCaseWithAccess(request, store, presetMatch[1]);
    if (body.walletAddress?.startsWith("0x")) {
      const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
      if (activated) caseRecord = activated;
    }
    assertCaseActivated(store, caseRecord);
    const { preset, plan, timeline } = await handleApplyPreset(store, caseRecord, body);
    sendJson(response, 201, {
      preset,
      plan,
      timeline,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const planMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/plan$/);
  if (method === "GET" && planMatch) {
    const caseRecord = getCaseWithAccess(request, store, planMatch[1]);
    const plan = store.agentPlanForCase(caseRecord.id);
    sendJson(response, 200, {
      plan: plan ? buildAgentPlanView(plan) : null,
      presets: CLEANUP_PRESETS,
      connectorResults: store.connectorResultsForCase(caseRecord.id),
      timeline: store.agentTimelineForCase(caseRecord.id)
    });
    return true;
  }

  const caseAgentRunMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/agent\/run$/);
  if (method === "POST" && caseAgentRunMatch) {
    const body = await readJson<CaseAgentRunBody>(request);
    const caseRecord = getCaseWithAccess(request, store, caseAgentRunMatch[1]);
    assertCaseActivated(store, caseRecord);
    const result = await handleAgentRun(store, caseRecord, trustCenterPath, {
      highAutonomy: body.highAutonomy
    });
    sendJson(response, 200, result);
    return true;
  }

  const intakeMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/intake$/);
  if (method === "POST" && intakeMatch) {
    const body = await readJson<IntakeBody>(request);
    const caseRecord = getCaseWithAccess(request, store, intakeMatch[1]);
    handleCaseIntake(store, caseRecord, body);
    sendJson(response, 200, {
      case: publicCaseView(caseRecord),
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const findingsListMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings$/);
  if (method === "GET" && findingsListMatch) {
    const caseRecord = getCaseWithAccess(request, store, findingsListMatch[1]);
    const status = buildStatus(store, caseRecord.id);
    const plan = store.agentPlanForCase(caseRecord.id);
    const presetId = plan?.presetId;
    sendJson(response, 200, {
      findings: status.findings,
      pendingFindings: status.pendingFindings,
      confirmedFindings: status.confirmedFindings,
      discovery: discoveryReadinessMessage(),
      discoveryPlan: describeDiscoveryPlan({
        scope: caseRecord.redactedScope,
        pastedUrlCount: 0,
        brokerSweep: presetId ? presetUsesBrokerDiscovery(presetId) : true,
        contentTakedown: presetId ? presetUsesContentDiscovery(presetId) : false
      })
    });
    return true;
  }

  const findingsDiscoverMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/discover$/);
  if (method === "POST" && findingsDiscoverMatch) {
    let caseRecord = getCaseWithAccess(request, store, findingsDiscoverMatch[1]);
    const body = await readJson<{ pastedUrls?: string[]; walletAddress?: string }>(request);
    if (body.walletAddress?.startsWith("0x")) {
      const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
      if (activated) caseRecord = activated;
    }
    assertCaseActivated(store, caseRecord);
    const walletAddress =
      body.walletAddress?.startsWith("0x") ? body.walletAddress : walletAddressForCase(store, caseRecord.id);
    if (!walletAddress && !creditsBypassEnabled()) {
      throw new HttpError(422, "wallet-address-required");
    }
    if (walletAddress) assertCreditsForDiscovery(store, walletAddress);
    const plan = store.agentPlanForCase(caseRecord.id);
    const presetId = plan?.presetId;
    const brokerSweep = presetId ? presetUsesBrokerDiscovery(presetId) : true;
    try {
      const { discovered, discovery, discoveryPlan } = await handleCaseDiscover(store, caseRecord, body, presetId);
      if (walletAddress && brokerSweep) {
        debitCreditsForDiscovery(store, walletAddress, caseRecord.id);
      }
      const timeline = createTimelineEvent(
        caseRecord.id,
        "ScoutAgent",
        "Discovery run",
        discovered.length
          ? `${discovered.length} candidate link(s) added for review.`
          : "No new candidates. Paste URLs or configure Brave search."
      );
      store.agentTimeline.set(timeline.id, timeline);
      sendJson(response, 201, {
        discovered,
        status: buildStatus(store, caseRecord.id),
        timeline,
        discovery,
        discoveryPlan,
        credits: walletAddress ? resolveCreditsView(store, walletAddress) : undefined,
        discoveryCreditsDebited: walletAddress && brokerSweep ? discoveryCredits() : 0
      });
    } catch (error) {
      throw new HttpError(502, "discovery-failed", {
        message: discoveryReadinessMessage(),
        detail: sanitizeForLog(error)
      });
    }
    return true;
  }

  const findingConfirmMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/([^/]+)\/(confirm|reject)$/);
  if (method === "POST" && findingConfirmMatch) {
    const caseRecord = getCaseWithAccess(request, store, findingConfirmMatch[1]);
    assertCaseActivated(store, caseRecord);
    const decision = findingConfirmMatch[3] === "confirm" ? "confirmed" : "rejected";
    const { exposure, timeline, status } = handleFindingDecision(
      store,
      caseRecord,
      findingConfirmMatch[2],
      decision
    );
    sendJson(response, 200, { exposure, status, timeline });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/actions/propose") {
    const body = await readJson<ProposeActionBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    assertCaseActivated(store, caseRecord);
    const { approval, action } = proposeApprovedAction({
      store,
      caseRecord,
      body: {
        ...body,
        identifiers: body.identifiers ?? [],
        dataToDisclose: body.dataToDisclose ?? []
      }
    });
    await emitApprovalPendingWebhook(store, caseRecord.id, approval);
    sendJson(response, 201, {
      policy: { allowed: true, reasons: [] },
      approval,
      action,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const body = await readJson<{ userConfirmation: string }>(request);
    const pendingApproval = store.approvals.get(approveMatch[1]);
    if (!pendingApproval) throw new HttpError(404, "approval-not-found");
    const approvalCase = getCaseWithAccess(request, store, pendingApproval.caseId);
    assertCaseActivated(store, approvalCase);
    const { approval, caseId } = await handleApprove(store, approveMatch[1], body);
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, { approval, status: buildStatus(store, caseId) });
    return true;
  }

  const executeMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const body = await readJson<{ hashPrefix?: string; emailLabel?: string; sourceUrl?: string; walletAddress?: string }>(request);
    const pendingAction = store.actions.get(executeMatch[1]);
    if (!pendingAction) throw new HttpError(404, "action-not-found");
    const executeCase = getCaseWithAccess(request, store, pendingAction.caseId);
    assertCaseActivated(store, executeCase);
    const { action, approval, executed, caseRecord } = await handleExecute(
      store,
      executeMatch[1],
      body,
      loadTrustCenterConfig
    );
    getCaseWithAccess(request, store, caseRecord.id);
    sendJson(response, 200, {
      action,
      approval,
      executorMode: executed.mode,
      connectorResult: executed.connectorResult,
      status: buildStatus(store, action.caseId)
    });
    return true;
  }

  return false;
}