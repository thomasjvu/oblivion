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
import { proposeApprovedAction } from "../../../domain/approvals.js";
import { buildStatus } from "../../../domain/status.js";
import { isEvmAddress } from "../../../domain/constants.js";
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
import { requireBillingWalletAddress } from "../../../domain/walletCases.js";
import { DomainError } from "../../../domain/errors.js";
import { createCaseRecord, publicCaseView } from "../../../domain/cases.js";
import { emitApprovalPendingWebhook } from "../../../domain/webhooks.js";
import type { AutonomyMode, PresetId } from "../../../domain/types.js";
import {
  resolveConsumerCaseForAction,
  resolveConsumerCaseForApproval,
  withActivatedConsumerCase,
  withConsumerCase
} from "../../handlers/caseRouteAdapters.js";
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
    const result = await withConsumerCase(request, store, caseReadMatch[1], (caseRecord) => ({
      case: publicCaseView(caseRecord)
    }));
    sendJson(response, 200, result);
    return true;
  }

  const presetMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/preset$/);
  if (method === "POST" && presetMatch) {
    const body = await readJson<{ presetId: PresetId; autonomyMode?: AutonomyMode; walletAddress?: string }>(
      request
    );
    const result = await withConsumerCase(request, store, presetMatch[1], async (caseRecord) => {
      if (isEvmAddress(body.walletAddress)) {
        const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
        if (activated) Object.assign(caseRecord, activated);
      }
      assertCaseActivated(store, caseRecord);
      const { preset, plan, timeline } = await handleApplyPreset(store, caseRecord, body);
      return { preset, plan, timeline };
    });
    sendJson(response, 201, result);
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
    const result = await withConsumerCase(request, store, intakeMatch[1], (caseRecord) => {
      handleCaseIntake(store, caseRecord, body);
      return { case: publicCaseView(caseRecord) };
    });
    sendJson(response, 200, result);
    return true;
  }

  const findingsListMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings$/);
  if (method === "GET" && findingsListMatch) {
    const result = await withConsumerCase(request, store, findingsListMatch[1], (caseRecord) => {
      const status = buildStatus(store, caseRecord.id);
      const plan = store.agentPlanForCase(caseRecord.id);
      const presetId = plan?.presetId;
      return {
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
      };
    });
    sendJson(response, 200, result);
    return true;
  }

  const findingsDiscoverMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/discover$/);
  if (method === "POST" && findingsDiscoverMatch) {
    const body = await readJson<{ pastedUrls?: string[]; walletAddress?: string }>(request);
    try {
      const result = await withConsumerCase(request, store, findingsDiscoverMatch[1], async (caseRecord) => {
        if (isEvmAddress(body.walletAddress)) {
          const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
          if (activated) Object.assign(caseRecord, activated);
        }
        assertCaseActivated(store, caseRecord);
        let walletAddress: string | undefined;
        try {
          walletAddress = creditsBypassEnabled()
            ? body.walletAddress?.startsWith("0x")
              ? body.walletAddress
              : undefined
            : requireBillingWalletAddress(store, caseRecord, body.walletAddress);
        } catch (error) {
          if (error instanceof DomainError) {
            throw new HttpError(error.statusCode, error.code, error.details);
          }
          throw error;
        }
        if (!walletAddress && !creditsBypassEnabled()) {
          throw new HttpError(422, "wallet-address-required");
        }
        if (walletAddress) assertCreditsForDiscovery(store, walletAddress);
        const plan = store.agentPlanForCase(caseRecord.id);
        const presetId = plan?.presetId;
        const brokerSweep = presetId ? presetUsesBrokerDiscovery(presetId) : true;
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
        return {
          discovered,
          timeline,
          discovery,
          discoveryPlan,
          credits: walletAddress ? resolveCreditsView(store, walletAddress) : undefined,
          discoveryCreditsDebited: walletAddress && brokerSweep ? discoveryCredits() : 0
        };
      });
      sendJson(response, 201, result);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "discovery-failed", {
        message: discoveryReadinessMessage(),
        detail: sanitizeForLog(error)
      });
    }
    return true;
  }

  const findingConfirmMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/([^/]+)\/(confirm|reject)$/);
  if (method === "POST" && findingConfirmMatch) {
    const decision = findingConfirmMatch[3] === "confirm" ? "confirmed" : "rejected";
    const result = await withActivatedConsumerCase(request, store, findingConfirmMatch[1], (caseRecord) => {
      const { exposure, timeline } = handleFindingDecision(
        store,
        caseRecord,
        findingConfirmMatch[2],
        decision
      );
      return { exposure, timeline };
    });
    sendJson(response, 200, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/actions/propose") {
    const body = await readJson<ProposeActionBody>(request);
    const result = await withActivatedConsumerCase(request, store, body.caseId, async (caseRecord) => {
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
      return {
        policy: { allowed: true, reasons: [] },
        approval,
        action
      };
    });
    sendJson(response, 201, result);
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const body = await readJson<{ userConfirmation: string }>(request);
    resolveConsumerCaseForApproval(request, store, approveMatch[1]);
    const { approval, caseId } = await handleApprove(store, approveMatch[1], body);
    sendJson(response, 200, { approval, status: buildStatus(store, caseId) });
    return true;
  }

  const executeMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const body = await readJson<{ hashPrefix?: string; emailLabel?: string; sourceUrl?: string; walletAddress?: string }>(request);
    resolveConsumerCaseForAction(request, store, executeMatch[1]);
    const { action, approval, executed } = await handleExecute(
      store,
      executeMatch[1],
      body,
      loadTrustCenterConfig
    );
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