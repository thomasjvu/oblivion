import { buildAttestationProof, type TrustCenterConfig } from "./attestation.js";
import {
  advanceAgentPlan,
  buildAgentPlanView,
  createAgentPlan,
  createDropPlan,
  createGoogleRemovalPlan,
  createScoutFindings,
  createPlanFollowUp,
  getPreset
} from "./cleanup.js";
import { deadlineBasisFor, followUpDate } from "./deadlines.js";
import { discoverExposureCandidates, discoveryReadinessMessage } from "./exposureDiscovery.js";
import { executeApprovedAction } from "./executor.js";
import { buildHackathonStatus, createTimelineEvent } from "./hackathon.js";
import { isVeniceConfigured, runVeniceAnalysis } from "./venice.js";
import { canExecuteWithApproval, evaluateProposedAction } from "./policy.js";
import { buildCaseStatus } from "./status.js";
import { buildDraftText, templateForAction } from "./templates.js";
import type {
  ActionRequest,
  ActionType,
  AgentPlan,
  AgentPlanStep,
  Approval,
  CaseRecord,
  ConnectorResult,
  Exposure,
  IdentifierCategory,
  Jurisdiction,
  PresetId
} from "./types.js";
import { HttpError } from "../api/errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export interface ProposedActionInput {
  caseId: string;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  sourceVerified?: boolean;
  plaintextPreview?: string;
  expectedConfirmationStep?: string;
}

export function createApproval(caseId: string, body: ProposedActionInput): Approval {
  const now = new Date();
  return {
    id: `approval_${crypto.randomUUID()}`,
    caseId,
    actionType: body.actionType,
    destination: body.destination,
    identifiersApproved: body.identifiers ?? [],
    dataToDisclose: body.dataToDisclose ?? [],
    purpose: body.purpose,
    disclosureRisk: "Approved data will be disclosed to the named destination if execution is connected to an external adapter.",
    expiresAt: followUpDate(7, now),
    status: "pending",
    createdAt: now.toISOString()
  };
}

export function createActionRequest(
  jurisdiction: Jurisdiction,
  approvalId: string,
  body: ProposedActionInput
): ActionRequest {
  return {
    id: `action_${crypto.randomUUID()}`,
    caseId: body.caseId,
    actionType: body.actionType,
    destination: body.destination,
    template: templateForAction(body.actionType, jurisdiction),
    draftText: buildDraftText({
      actionType: body.actionType,
      jurisdiction,
      destination: body.destination,
      purpose: body.purpose
    }),
    deadlineBasis: deadlineBasisFor(body.actionType, jurisdiction),
    expectedConfirmationStep: body.expectedConfirmationStep ?? "User confirms the destination and approved data before external submission.",
    approvalId,
    executionStatus: "awaiting-approval",
    createdAt: new Date().toISOString()
  };
}

export function proposeApprovedAction(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  body: ProposedActionInput;
}): { approval: Approval; action: ActionRequest } {
  const policy = evaluateProposedAction({
    authorityBasis: input.caseRecord.authorityBasis,
    actionType: input.body.actionType,
    destination: input.body.destination,
    purpose: input.body.purpose,
    identifiers: input.body.identifiers,
    dataToDisclose: input.body.dataToDisclose,
    plaintextPreview: input.body.plaintextPreview,
    sourceVerified: input.body.sourceVerified,
    hasApproval: false
  });
  if (!policy.allowed) throw new HttpError(422, "policy-blocked", { reasons: policy.reasons });
  const approval = createApproval(input.caseRecord.id, input.body);
  const action = createActionRequest(input.caseRecord.jurisdiction, approval.id, input.body);
  input.store.approvals.set(approval.id, approval);
  input.store.actions.set(action.id, action);
  return { approval, action };
}

export async function runCleanupAgentStep(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  trustCenterConfig: () => Promise<TrustCenterConfig>;
  highAutonomy?: boolean;
}) {
  const plan = input.store.agentPlanForCase(input.caseRecord.id);
  if (!plan) throw new HttpError(409, "preset-required", { next: buildAgentNextStep(input.store, input.caseRecord.id) });
  const before = buildAgentNextStep(input.store, input.caseRecord.id);
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
    if (presetId === "breach-exposure" || presetId === "search-result-suppression" || presetId === "california-drop" || presetId === "gdpr-erasure") {
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
        scope: input.caseRecord.redactedScope,
        existingUrls
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
    const connector = updatedPlan.presetId === "california-drop"
      ? createDropPlan(input.caseRecord)
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
  } else if (updatedPlan.currentStep === "draft-actions") {
    if (isVeniceConfigured()) {
      const confirmedNotes = buildStatus(input.store, input.caseRecord.id)
        .confirmedFindings.map((item) => `${item.brokerLabel || "broker"}: ${item.sourceUrl}`)
        .join("; ");
      const analysis = await runVeniceAnalysis({
        caseId: input.caseRecord.id,
        kind: "draft-request",
        notes: confirmedNotes || preset.summary,
        destination: preset.title,
        actionType:
          updatedPlan.presetId === "search-result-suppression"
            ? "search-result-removal"
            : updatedPlan.presetId === "gdpr-erasure"
              ? input.caseRecord.jurisdiction === "UK"
                ? "uk-gdpr-erasure"
                : "gdpr-erasure"
              : "broker-opt-out"
      });
      input.store.veniceAnalyses.set(analysis.id, analysis);
      const readyAction = input.store.actionsForCase(input.caseRecord.id).find((item) => item.executionStatus === "awaiting-approval");
      if (readyAction && analysis.output.draftText) {
        readyAction.draftText = analysis.output.draftText;
      }
      const veniceTimeline = createTimelineEvent(
        input.caseRecord.id,
        "Venice",
        analysis.output.title,
        analysis.output.summary
      );
      input.store.agentTimeline.set(veniceTimeline.id, veniceTimeline);
      artifacts.push({ analysis, veniceTimeline });
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
      const proposed = createPresetApproval(input.store, input.caseRecord, updatedPlan.presetId);
      const timeline = createTimelineEvent(
        input.caseRecord.id,
        "OblivionRoot",
        "Approval required",
        "An exact disclosure card is ready. The agent cannot submit without approval."
      );
      input.store.agentTimeline.set(timeline.id, timeline);
      updatedPlan = {
        ...updatedPlan,
        pendingApprovals: [proposed.approval.id],
        blockedReasons: ["approval-required"],
        nextUserDecision: "Approve or reject the exact disclosure card.",
        updatedAt: new Date().toISOString()
      };
      input.store.agentPlans.set(updatedPlan.id, updatedPlan);
      artifacts.push({ ...proposed, timeline });
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
        trustCenterConfig: await input.trustCenterConfig()
      });
      action.executionStatus = executed.connectorResult?.status === "failed" ? "failed" : "recorded";
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
    const followUp = createPlanFollowUp(input.caseRecord.id, updatedPlan.presetId);
    input.store.followUps.set(followUp.id, followUp);
    const timeline = createTimelineEvent(
      input.caseRecord.id,
      "SchedulerAgent",
      "Recheck scheduled",
      followUp.expectedResponseWindow
    );
    input.store.agentTimeline.set(timeline.id, timeline);
    artifacts.push({ followUp, timeline });
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

export function createPresetApproval(store: MemoryStore, caseRecord: CaseRecord, presetId: PresetId): { approval: Approval; action: ActionRequest } {
  const preset = getPreset(presetId);
  const actionType: ActionType =
    presetId === "search-result-suppression"
      ? "search-result-removal"
      : presetId === "gdpr-erasure"
        ? caseRecord.jurisdiction === "UK" ? "uk-gdpr-erasure" : "gdpr-erasure"
        : presetId === "breach-exposure"
          ? "hibp-email-check"
          : "broker-opt-out";
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const primaryConfirmed = confirmed[0];
  const destination =
    presetId === "search-result-suppression"
      ? "Google Search removal flow"
      : presetId === "california-drop"
        ? "California DROP"
        : presetId === "gdpr-erasure"
          ? "Named data controller"
          : presetId === "breach-exposure"
            ? "Have I Been Pwned"
            : presetId === "high-risk-safety"
              ? "Confirmed high-risk exposure source"
              : primaryConfirmed?.brokerLabel || primaryConfirmed?.sourceUrl || "Confirmed people-search broker";
  const identifiers = preset.requiredIdentifierCategories.filter((category) => category !== "password");
  const dataToDisclose: IdentifierCategory[] = presetId === "breach-exposure" ? ["email"] : identifiers.slice(0, 3);
  const body: ProposedActionInput = {
    caseId: caseRecord.id,
    actionType,
    destination,
    purpose: presetId === "breach-exposure"
      ? "Check approved email exposure through HIBP for mitigation guidance only."
      : preset.summary,
    identifiers,
    dataToDisclose,
    sourceVerified: true,
    expectedConfirmationStep:
      "User reviews destination, data categories, purpose, disclosure risk, and expiration before execution."
  };
  return proposeApprovedAction({ store, caseRecord, body });
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

export function buildStatus(store: MemoryStore, caseId: string) {
  const caseRecord = store.getCaseOrThrow(caseId);
  return buildCaseStatus({
    caseRecord,
    exposures: store.exposuresForCase(caseId),
    approvals: store.approvalsForCase(caseId),
    actions: store.actionsForCase(caseId),
    followUps: store.followUpsForCase(caseId)
  });
}

export function buildHackathonStatusForCase(store: MemoryStore, caseId: string) {
  return buildHackathonStatus({
    caseId,
    permissions: store.permissionGrantsForCase(caseId),
    payments: store.paymentSessionsForCase(caseId),
    veniceAnalyses: store.veniceAnalysesForCase(caseId),
    delegations: store.agentDelegationsForCase(caseId),
    relayerEvents: store.relayerEventsForCase(caseId)
  });
}

export function buildAgentNextStep(store: MemoryStore, caseId: string) {
  const plan = store.agentPlanForCase(caseId);
  if (!plan) {
    return {
      action: "select-preset",
      title: "Choose cleanup preset",
      message: "Select a cleanup route so I can build the right agent plan.",
      plan: null
    };
  }
  return {
    action: plan.currentStep,
    title: titleForPlanStep(plan.currentStep),
    message: plan.nextUserDecision,
    blockedReasons: plan.blockedReasons,
    plan: buildAgentPlanView(plan)
  };
}

export function titleForPlanStep(step: AgentPlanStep): string {
  return {
    "select-preset": "Choose cleanup preset",
    "collect-minimum-identifiers": "Collect minimum identifiers",
    "verify-trust": "Verify runtime trust",
    "discover-candidates": "Discover exposure candidates",
    "confirm-matches": "Confirm matches",
    "verify-removal-path": "Verify removal path",
    "draft-actions": "Draft actions",
    "request-approval": "Approval required",
    "execute-approved-action": "Execute approved action",
    "await-confirmation": "Await confirmation",
    "schedule-recheck": "Schedule recheck",
    "escalate-if-needed": "Escalate if needed",
    "complete": "Cleanup cycle complete"
  }[step];
}
