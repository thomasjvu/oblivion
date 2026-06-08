import { buildAttestationProof, type TrustCenterConfig } from "./attestation.js";
import { brokerCatalogEntryById, dataToDiscloseForBroker } from "./brokerCatalog.js";
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
  getPreset,
  presetUsesBrokerDiscovery,
  presetUsesContentDiscovery
} from "./cleanup.js";
import { deadlineBasisFor, followUpDate } from "./deadlines.js";
import { emitCaseCompletedWebhook, emitRecheckScheduledWebhooks } from "./webhooks.js";
import { discoverExposureCandidates, discoveryReadinessMessage } from "./exposureDiscovery.js";
import { buildExecuteHandoff } from "./executeHandoff.js";
import { hostFromDestination, resolveHostAbuseContact } from "./platformAbuse.js";
import { executeApprovedAction, resolveExecutionStatusAfterExecute } from "./executor.js";
import { buildHackathonStatus, createTimelineEvent } from "./hackathon.js";
import { assertPartnerAiBudget, meterPartnerAiTokens } from "./partnerBilling.js";
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
        actionType: actionTypeForPreset(updatedPlan.presetId, input.caseRecord.jurisdiction)
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

export function actionTypeForPreset(presetId: PresetId, jurisdiction: Jurisdiction): ActionType {
  if (presetId === "search-result-suppression") return "search-result-removal";
  if (presetId === "gdpr-erasure") return jurisdiction === "UK" ? "uk-gdpr-erasure" : "gdpr-erasure";
  if (presetId === "breach-exposure") return "hibp-email-check";
  if (presetId === "content-takedown") return "dmca-takedown";
  return "broker-opt-out";
}

export function createPresetApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  if (presetUsesBrokerDiscovery(plan.presetId) || plan.presetId === "high-risk-safety") {
    return createBrokerOptOutApprovals(store, caseRecord, plan);
  }
  if (plan.presetId === "content-takedown") {
    return createContentTakedownApprovals(store, caseRecord, plan);
  }
  if (plan.presetId === "breach-exposure") {
    return createBreachExposureApprovals(store, caseRecord);
  }
  return [createPresetApproval(store, caseRecord, plan.presetId)];
}

function buildExecuteHandoffFromStore(store: MemoryStore, action: ActionRequest) {
  const exposures = store.exposuresForCase(action.caseId);
  return buildExecuteHandoff({
    action: {
      actionType: action.actionType,
      exposureId: action.exposureId,
      destination: action.destination
    },
    status: {
      confirmedFindings: exposures
        .filter((item) => item.matchStatus === "confirmed")
        .map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
      pendingFindings: exposures
        .filter((item) => item.matchStatus === "pending")
        .map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
      findings: exposures.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl }))
    }
  });
}

export function createBreachExposureApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord
): Array<{ approval: Approval; action: ActionRequest }> {
  const emailCheck = createPresetApproval(store, caseRecord, "breach-exposure");
  const passwordBody: ProposedActionInput = {
    caseId: caseRecord.id,
    actionType: "pwned-password-range-check",
    destination: "Have I Been Pwned — Pwned Passwords",
    purpose: "Check approved password exposure using SHA-1 prefix range lookup only.",
    identifiers: [],
    dataToDisclose: [],
    sourceVerified: true,
    expectedConfirmationStep:
      "User supplies password in browser vault only; server receives a 5-character SHA-1 prefix."
  };
  const passwordCheck = proposeApprovedAction({ store, caseRecord, body: passwordBody });
  return [emailCheck, passwordCheck];
}

/** @deprecated use createPresetApprovals */
export function createPresetApproval(store: MemoryStore, caseRecord: CaseRecord, presetId: PresetId): { approval: Approval; action: ActionRequest } {
  const preset = getPreset(presetId);
  const actionType = actionTypeForPreset(presetId, caseRecord.jurisdiction);
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
  const proposed = proposeApprovedAction({ store, caseRecord, body });
  if (primaryConfirmed) {
    proposed.action.exposureId = primaryConfirmed.id;
    proposed.action.brokerId = primaryConfirmed.brokerId;
  }
  return proposed;
}

export function createBrokerOptOutApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  const preset = getPreset(plan.presetId);
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const limit = plan.batchApprovalPolicy?.maxDestinations ?? confirmed.length;
  const targets = confirmed.slice(0, limit);
  const allowedIdentifiers = preset.requiredIdentifierCategories.filter((category) => category !== "password");
  const results: Array<{ approval: Approval; action: ActionRequest }> = [];
  for (const exposure of targets) {
    const catalog = exposure.brokerId ? brokerCatalogEntryById(exposure.brokerId) : undefined;
    const destination = catalog?.officialOptOutUrl ?? exposure.officialOptOutUrl ?? exposure.sourceUrl;
    const dataToDisclose = catalog
      ? dataToDiscloseForBroker(catalog, allowedIdentifiers)
      : allowedIdentifiers.slice(0, 3);
    const body: ProposedActionInput = {
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination,
      purpose: `Opt out of ${catalog?.brokerLabel ?? exposure.brokerLabel ?? "people-search"} listing at approved profile URL.`,
      identifiers: allowedIdentifiers,
      dataToDisclose: dataToDisclose.length ? dataToDisclose : ["legal-name", "email"],
      sourceVerified: true,
      expectedConfirmationStep: "User reviews broker destination, approved identifiers, and profile URL before submission."
    };
    const proposed = proposeApprovedAction({ store, caseRecord, body });
    proposed.action.brokerId = exposure.brokerId ?? catalog?.brokerId;
    proposed.action.exposureId = exposure.id;
    if (catalog && !catalog.teeAutomatable) {
      proposed.action.draftText = [
        proposed.action.draftText,
        "",
        `Submission method: ${catalog.submissionMethod}. User-held steps may be required.`
      ].join("\n");
    }
    results.push(proposed);
  }
  return results.length ? results : [createPresetApproval(store, caseRecord, plan.presetId)];
}

function contentTakedownHostForExposure(exposure: Exposure): string {
  return hostFromDestination(exposure.sourceUrl) || exposure.sourceUrl;
}

function proposeDmcaTakedownApproval(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    destination: string;
    purpose: string;
    exposureId?: string;
    expectedConfirmationStep?: string;
  }
): { approval: Approval; action: ActionRequest } {
  const proposed = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "dmca-takedown",
      destination: input.destination,
      purpose: input.purpose,
      identifiers: ["legal-name", "email", "infringing-url", "original-work-ref"],
      dataToDisclose: ["legal-name", "email", "infringing-url"],
      sourceVerified: true,
      expectedConfirmationStep:
        input.expectedConfirmationStep ??
        "User confirms they are the rights holder or authorized agent before DMCA submission."
    }
  });
  if (input.exposureId) proposed.action.exposureId = input.exposureId;
  return proposed;
}

function proposePlatformAbuseApproval(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    destination: string;
    infringingUrl: string;
    exposureId?: string;
    expectedConfirmationStep?: string;
  }
): { approval: Approval; action: ActionRequest } {
  const contact = resolveHostAbuseContact(input.destination, input.infringingUrl);
  const host = contact?.host ?? input.destination;
  const abuseChannel = contact?.email ?? `abuse@${host}`;
  const proposed = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "platform-abuse-report",
      destination: host,
      purpose: `Report unauthorized copy at ${input.infringingUrl} via ${abuseChannel}.`,
      identifiers: ["legal-name", "email", "infringing-url", "original-work-ref"],
      dataToDisclose: ["legal-name", "email", "infringing-url"],
      sourceVerified: true,
      expectedConfirmationStep:
        input.expectedConfirmationStep ??
        "User confirms host abuse contact and infringing URL before platform abuse submission."
    }
  });
  if (input.exposureId) proposed.action.exposureId = input.exposureId;
  return proposed;
}

export function createContentTakedownApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const limit = plan.batchApprovalPolicy?.maxDestinations ?? confirmed.length;
  const targets = confirmed.slice(0, limit || 1);
  if (!targets.length) {
    return [
      proposeDmcaTakedownApproval(store, caseRecord, {
        destination: "Infringing host abuse contact",
        purpose: "Remove unauthorized copies of approved original work at pasted URLs."
      }),
      proposePlatformAbuseApproval(store, caseRecord, {
        destination: "Infringing host",
        infringingUrl: "https://infringing.example/unauthorized-copy",
        expectedConfirmationStep:
          "User confirms host abuse contact and infringing URL before platform abuse submission."
      })
    ];
  }
  const results: Array<{ approval: Approval; action: ActionRequest }> = [];
  for (const exposure of targets) {
    const host = contentTakedownHostForExposure(exposure);
    results.push(
      proposeDmcaTakedownApproval(store, caseRecord, {
        destination: host,
        purpose: `Takedown unauthorized copy at ${exposure.sourceUrl}. Rights-holder authority confirmed in intake.`,
        exposureId: exposure.id
      }),
      proposePlatformAbuseApproval(store, caseRecord, {
        destination: host,
        infringingUrl: exposure.sourceUrl,
        exposureId: exposure.id
      })
    );
  }
  return results;
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

export function buildHackathonStatusForCase(store: MemoryStore, caseId: string, walletAddress?: string) {
  return buildHackathonStatus({
    caseId,
    permissions: store.permissionGrantsForCase(caseId),
    payments: store.paymentSessionsForCase(caseId),
    veniceAnalyses: store.veniceAnalysesForCase(caseId),
    delegations: store.agentDelegationsForCase(caseId),
    relayerEvents: store.relayerEventsForCase(caseId),
    walletAddress,
    store
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
