import { buildAttestationProof, type TrustCenterConfig } from "./attestation.js";
import {
  advanceAgentPlan,
  buildAgentPlanView,
  createAgentPlan,
  createBrokerFollowUps,
  createBrokerRemovalPathPlan,
  createContentAbusePathPlan,
  createDropPlan,
  createGoogleRemovalPlan,
  createScoutFindings,
  createPlanFollowUp,
  defaultActionTypeForPreset,
  getPreset,
  presetUsesBrokerDiscovery,
  presetUsesContentDiscovery,
  presetUsesOfficialPathDiscovery
} from "./cleanup.js";
import { emitCaseCompletedWebhook, emitRecheckScheduledWebhooks } from "./webhooks.js";
import { discoverExposureCandidates, discoveryReadinessMessage } from "./exposureDiscovery.js";
import { executeApprovedAction, resolveExecutionStatusAfterExecute } from "./executor.js";
import { createTimelineEvent } from "./hackathon.js";
import { assertPartnerAiBudget, meterPartnerAiTokens } from "./partnerBilling.js";
import { isVeniceConfigured, runVeniceAnalysis } from "./venice.js";
import { canExecuteWithApproval } from "./policy.js";
import type { AgentPlan, CaseRecord, ConnectorResult, Exposure } from "./types.js";
import { HttpError } from "../api/errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { buildExecuteHandoffFromStore, createPresetApprovals } from "./approvals.js";
import {
  buildAgentNextStep,
  buildHackathonStatusForCase,
  buildStatus
} from "./orchestration.js";

export async function runCleanupAgentStep(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  trustCenterConfig: () => Promise<TrustCenterConfig>;
  highAutonomy?: boolean;
}) {
  const plan = input.store.agentPlanForCase(input.caseRecord.id);
  if (!plan) throw new HttpError(409, "preset-required", { next: buildAgentNextStep(input.store, input.caseRecord.id) });
  const before = buildAgentNextStep(input.store, input.caseRecord.id);
  const stepBefore = plan.currentStep;
  const artifacts: unknown[] = [];
  const trustProof = await buildAttestationProof(await input.trustCenterConfig(), { fetchLive: true });
  let updatedPlan: AgentPlan = plan;
  const preset = getPreset(plan.presetId);

  if (input.highAutonomy && updatedPlan.autonomyMode !== "high-autonomy") {
    updatedPlan = createAgentPlan({
      caseRecord: input.caseRecord,
      presetId: plan.presetId,
      autonomyMode: "high-autonomy"
    });
    input.store.agentPlans.set(updatedPlan.id, updatedPlan);
    artifacts.push({ highAutonomyEnabled: true, batchApprovalPolicy: updatedPlan.batchApprovalPolicy });
  }

  if (updatedPlan.currentStep === "discover-candidates") {
    const presetId = updatedPlan.presetId;
    if (presetUsesOfficialPathDiscovery(presetId)) {
      const connector = createScoutFindings(input.caseRecord.id, presetId);
      input.store.connectorResults.set(connector.id, connector);
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "ScoutAgent",
        "Official path mapped",
        connector.summary
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      artifacts.push({ connector, timeline });
    } else {
      const existingUrls = input.store.exposuresForCase(input.caseRecord.id).map((item) => item.sourceUrl);
      const discovered = await discoverExposureCandidates({
        caseId: input.caseRecord.id,
        store: input.store,
        scope: input.caseRecord.redactedScope,
        existingUrls,
        brokerSweep: presetUsesBrokerDiscovery(presetId),
        contentTakedown: presetUsesContentDiscovery(presetId)
      });
      for (const exposure of discovered) {
        input.store.exposures.set(exposure.id, exposure);
      }
      const connector = createScoutFindings(input.caseRecord.id, presetId);
      input.store.connectorResults.set(connector.id, connector);
      if (presetId === "high-risk-safety" && discovered.length === 0) {
        const guidance = exposureFromConnector(connector);
        input.store.exposures.set(guidance.id, {
          ...guidance,
          matchStatus: "pending",
          matchScore: "uncertain",
          matchReason: "High-risk guidance source — confirm before drafting removals.",
          brokerLabel: "Official guidance",
          removalStatus: "not-started"
        });
      }
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "ScoutAgent",
        discovered.length ? "Exposure candidates discovered" : "No new candidates",
        discovered.length
          ? `${discovered.length} links queued for review. ${discoveryReadinessMessage()}`
          : discoveryReadinessMessage()
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      artifacts.push({ exposures: discovered, connector, timeline });
    }
  } else if (updatedPlan.currentStep === "confirm-matches") {
    const caseStatus = buildStatus(input.store, input.caseRecord.id);
    if (caseStatus.pendingFindings.length > 0) {
      updatedPlan = {
        ...updatedPlan,
        blockedReasons: ["candidate-confirmation-needed"],
        nextUserDecision: `Review ${caseStatus.pendingFindings.length} pending link(s): confirm yours or mark Not me.`,
        updatedAt: new Date().toISOString()
      };
      updatedPlan.visualNodes = advanceAgentPlan({
        plan: updatedPlan,
        caseRecord: input.caseRecord,
        findingsCount: caseStatus.confirmedFindings.length,
        pendingFindingsCount: caseStatus.pendingFindings.length,
        approvalsPending: 0,
        actionsReady: 0,
        submittedActions: 0,
        trustPass: trustProof.verifierResult === "pass"
      }).visualNodes.map((node) => (node.id === "confirm-matches" ? { ...node, status: "blocked" as const } : node));
      input.store.agentPlans.set(updatedPlan.id, updatedPlan);
      artifacts.push({ blocked: "candidate-confirmation-needed", pending: caseStatus.pendingFindings.length });
      return buildAgentRunResponse(input.store, input.caseRecord.id, before, artifacts);
    }
    if (caseStatus.confirmedFindings.length === 0) {
      updatedPlan = {
        ...updatedPlan,
        blockedReasons: ["no-confirmed-matches"],
        nextUserDecision: "Confirm at least one listing or paste more URLs and discover again.",
        updatedAt: new Date().toISOString()
      };
      input.store.agentPlans.set(updatedPlan.id, updatedPlan);
      artifacts.push({ blocked: "no-confirmed-matches" });
      return buildAgentRunResponse(input.store, input.caseRecord.id, before, artifacts);
    }
  } else if (updatedPlan.currentStep === "verify-removal-path") {
    const confirmedCount = buildStatus(input.store, input.caseRecord.id).confirmedFindings.length;
    if (updatedPlan.presetId === "content-takedown") {
      const dmcaConnector = createScoutFindings(input.caseRecord.id, "content-takedown");
      const abuseConnector = createContentAbusePathPlan(input.caseRecord.id, confirmedCount);
      input.store.connectorResults.set(dmcaConnector.id, dmcaConnector);
      input.store.connectorResults.set(abuseConnector.id, abuseConnector);
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "DraftAgent",
        "Takedown paths verified",
        `${dmcaConnector.summary} ${abuseConnector.summary}`
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      artifacts.push({ connector: dmcaConnector, abuseConnector, timeline });
    } else {
      const connector =
        updatedPlan.presetId === "california-drop"
          ? createDropPlan(input.caseRecord)
          : presetUsesBrokerDiscovery(updatedPlan.presetId)
            ? createBrokerRemovalPathPlan(input.caseRecord.id, confirmedCount)
            : createGoogleRemovalPlan(input.caseRecord.id);
      input.store.connectorResults.set(connector.id, connector);
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        connector.connectorId === "california-drop-guided" ? "DROP" : "Google",
        "Official removal path verified",
        connector.summary
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      artifacts.push({ connector, timeline });
    }
  } else if (updatedPlan.currentStep === "draft-actions") {
    if (isVeniceConfigured()) {
      const confirmedNotes = buildStatus(input.store, input.caseRecord.id)
        .confirmedFindings.map((item) => `${item.brokerLabel || "broker"}: ${item.sourceUrl}`)
        .join("; ");
      assertPartnerAiBudget(input.store, input.caseRecord.id);
      const analysis = await runVeniceAnalysis({
        caseId: input.caseRecord.id,
        kind: "draft-request",
        notes: confirmedNotes || preset.summary,
        destination: preset.title,
        actionType: defaultActionTypeForPreset(updatedPlan.presetId, input.caseRecord.jurisdiction)
      });
      meterPartnerAiTokens(input.store, input.caseRecord.id, analysis.tokensUsed);
      const { tokensUsed: _tokensUsed, ...storedAnalysis } = analysis;
      input.store.veniceAnalyses.set(storedAnalysis.id, storedAnalysis);
      const readyAction = input.store.actionsForCase(input.caseRecord.id).find((item) => item.executionStatus === "awaiting-approval");
      if (readyAction && storedAnalysis.output.draftText) {
        readyAction.draftText = storedAnalysis.output.draftText;
      }
      const veniceTimeline = createTimelineEvent(
        input.caseRecord.id,
        "Venice",
        storedAnalysis.output.title,
        storedAnalysis.output.summary
      );
      input.store.agentTimeline.set(veniceTimeline.id, veniceTimeline);
      artifacts.push({ analysis: storedAnalysis, veniceTimeline });
    }
    const timeline = createTimelineEvent(
      input.caseRecord.id,
      "DraftAgent",
      "Request drafted",
      `${preset.title} request draft is ready for approval review.`
    );
    input.store.agentTimeline.set(timeline.id, timeline);
    artifacts.push({ timeline });
  } else if (updatedPlan.currentStep === "request-approval") {
    const caseStatus = buildStatus(input.store, input.caseRecord.id);
    if (caseStatus.approvalsNeeded.length === 0 && caseStatus.actionsReady.length === 0 && caseStatus.submittedActions.length === 0) {
      const proposedList = createPresetApprovals(input.store, input.caseRecord, updatedPlan);
      const contentTakedown = updatedPlan.presetId === "content-takedown";
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "OblivionRoot",
        "Approval required",
        proposedList.length > 1
          ? contentTakedown
            ? `${proposedList.length} DMCA and platform abuse cards are ready. Approve each before host contact.`
            : `${proposedList.length} per-broker disclosure cards are ready. Approve each before submission.`
          : "An exact disclosure card is ready. The agent cannot submit without approval."
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      updatedPlan = {
        ...updatedPlan,
        pendingApprovals: proposedList.map((item) => item.approval.id),
        blockedReasons: ["approval-required"],
        nextUserDecision:
          proposedList.length > 1
            ? contentTakedown
              ? `Approve ${proposedList.length} disclosure cards (DMCA + platform abuse per confirmed URL).`
              : `Approve ${proposedList.length} disclosure cards (one per confirmed listing).`
            : "Approve or reject the exact disclosure card.",
        updatedAt: new Date().toISOString()
      };
      input.store.agentPlans.set(updatedPlan.id, updatedPlan);
      artifacts.push({ approvals: proposedList, timeline });
      return buildAgentRunResponse(input.store, input.caseRecord.id, before, artifacts);
    }
  } else if (updatedPlan.currentStep === "execute-approved-action") {
    const action = input.store.actionsForCase(input.caseRecord.id).find((item) => item.executionStatus === "ready");
    if (action) {
      const approval = input.store.approvals.get(action.approvalId);
      if (!approval) throw new HttpError(409, "approval-missing");
      const decision = canExecuteWithApproval(approval);
      if (!decision.allowed) throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
      const executed = await executeApprovedAction({
        store: input.store,
        action,
        approval,
        trustCenterConfig: await input.trustCenterConfig(),
        handoff: buildExecuteHandoffFromStore(input.store, action)
      });
      action.executionStatus = resolveExecutionStatusAfterExecute(executed);
      action.executedAt = new Date().toISOString();
      action.executionRecord = executed.executionRecord;
      approval.status = "used";
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "OblivionRoot",
        "Submitted",
        executed.mode === "live"
          ? "Approved action executed via live connector path."
          : "Approved action recorded for user-held or connector-backed submission."
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      artifacts.push({ action, approval, timeline, connectorResult: executed.connectorResult });
    }
  } else if (updatedPlan.currentStep === "schedule-recheck") {
    const confirmed = buildStatus(input.store, input.caseRecord.id).confirmedFindings;
    const brokerFollowUps =
      presetUsesBrokerDiscovery(updatedPlan.presetId) && confirmed.length
        ? createBrokerFollowUps(input.caseRecord.id, confirmed)
        : [];
    const followUps =
      brokerFollowUps.length > 0
        ? brokerFollowUps
        : [createPlanFollowUp(input.caseRecord.id, updatedPlan.presetId)];
    for (const followUp of followUps) {
      input.store.followUps.set(followUp.id, followUp);
    }
    await emitRecheckScheduledWebhooks(input.store, input.caseRecord.id, followUps);
    const timeline = createTimelineEvent(
      input.caseRecord.id,
      "SchedulerAgent",
      "Recheck scheduled",
      brokerFollowUps.length
        ? `${brokerFollowUps.length} broker recheck(s) scheduled from catalog windows.`
        : followUps[0].expectedResponseWindow
    );
    input.store.agentTimeline.set(timeline.id, timeline);
    artifacts.push({ followUps, timeline });
  }

  const caseStatus = buildStatus(input.store, input.caseRecord.id);
  updatedPlan = advanceAgentPlan({
    plan: updatedPlan,
    caseRecord: input.caseRecord,
    findingsCount: caseStatus.confirmedFindings.length,
    pendingFindingsCount: caseStatus.pendingFindings.length,
    approvalsPending: caseStatus.approvalsNeeded.length,
    actionsReady: caseStatus.actionsReady.length,
    submittedActions: caseStatus.submittedActions.length,
    trustPass: trustProof.verifierResult === "pass"
  });
  input.store.agentPlans.set(updatedPlan.id, updatedPlan);
  await emitCaseCompletedWebhook(input.store, input.caseRecord.id, stepBefore, updatedPlan.currentStep);
  return buildAgentRunResponse(input.store, input.caseRecord.id, before, artifacts);
}

export function buildAgentRunResponse(store: MemoryStore, caseId: string, before: unknown, artifacts: unknown[]) {
  return {
    ran: before,
    next: buildAgentNextStep(store, caseId),
    plan: store.agentPlanForCase(caseId) ? buildAgentPlanView(store.agentPlanForCase(caseId)!) : null,
    artifacts,
    connectorResults: store.connectorResultsForCase(caseId),
    timeline: store.agentTimelineForCase(caseId),
    status: buildHackathonStatusForCase(store, caseId),
    caseStatus: buildStatus(store, caseId)
  };
}

export function exposureFromConnector(result: ConnectorResult): Exposure {
  return {
    id: `exposure_${crypto.randomUUID()}`,
    caseId: result.caseId,
    sourceUrl: result.sourceUrl,
    visibleDataCategories: ["email", "city-state"],
    confidence: result.confidence,
    evidencePointer: `connector://${result.id}`,
    officialRemovalPath: result.officialRemovalPath,
    createdAt: result.createdAt
  };
}