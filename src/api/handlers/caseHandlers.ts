import type { TrustCenterConfig } from "../../domain/attestation.js";
import {
  buildAgentPlanView,
  createAgentPlan,
  getPreset,
  presetUsesBrokerDiscovery,
  presetUsesContentDiscovery
} from "../../domain/cleanup.js";
import { sanitizeScope, validateEncryptedBlob } from "../../domain/cases.js";
import { createTimelineEvent } from "../../domain/hackathon.js";
import {
  applyFindingDecision,
  describeDiscoveryPlan,
  discoverExposureCandidates,
  discoveryReadinessMessage
} from "../../domain/exposureDiscovery.js";
import { canExecuteWithApproval } from "../../domain/policy.js";
import { buildStatus } from "../../domain/orchestration.js";
import { redactText } from "../../domain/redaction.js";
import { executeApprovedAction, resolveExecutionStatusAfterExecute } from "../../domain/executor.js";
import { emitCaseWebhook } from "../../domain/webhooks.js";
import type {
  AutonomyMode,
  CaseRecord,
  EncryptedBlob,
  PresetId,
  RedactedScope
} from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { HttpError } from "../errors.js";
import { handleAgentRun } from "./agentRun.js";

export interface IntakeBody {
  encryptedIntake: EncryptedBlob;
  redactedScope: RedactedScope;
}

export interface ApplyPresetBody {
  presetId: PresetId;
  autonomyMode?: AutonomyMode;
}

export interface DiscoverBody {
  pastedUrls?: string[];
}

export interface ApproveBody {
  userConfirmation: string;
}

export interface ExecuteActionBody {
  hashPrefix?: string;
  emailLabel?: string;
  sourceUrl?: string;
  walletAddress?: string;
}

export function handleCaseIntake(
  _store: MemoryStore,
  caseRecord: CaseRecord,
  body: IntakeBody
): { caseRecord: CaseRecord } {
  validateEncryptedBlob(body.encryptedIntake);
  caseRecord.encryptedIntake = body.encryptedIntake;
  caseRecord.redactedScope = sanitizeScope(body.redactedScope);
  caseRecord.updatedAt = new Date().toISOString();
  return { caseRecord };
}

export async function handleApplyPreset(
  store: MemoryStore,
  caseRecord: CaseRecord,
  body: ApplyPresetBody,
  options: { emitWebhook?: boolean } = {}
) {
  const plan = createAgentPlan({
    caseRecord,
    presetId: body.presetId,
    autonomyMode: body.autonomyMode
  });
  store.agentPlans.set(plan.id, plan);
  const preset = getPreset(plan.presetId);
  const timeline = createTimelineEvent(
    caseRecord.id,
    "OblivionRoot",
    "Preset selected",
    `${preset.title} started in ${plan.autonomyMode} mode.`
  );
  store.agentTimeline.set(timeline.id, timeline);
  if (options.emitWebhook) {
    await emitCaseWebhook(store, caseRecord.id, "case.phase_changed", {
      currentStep: plan.currentStep,
      presetId: plan.presetId
    });
  }
  return { preset, plan: buildAgentPlanView(plan), timeline };
}

export async function handleCaseDiscover(
  store: MemoryStore,
  caseRecord: CaseRecord,
  body: DiscoverBody,
  presetId?: PresetId
) {
  const existingUrls = store.exposuresForCase(caseRecord.id).map((item) => item.sourceUrl);
  const brokerSweep = presetId ? presetUsesBrokerDiscovery(presetId) : true;
  const contentTakedown = presetId ? presetUsesContentDiscovery(presetId) : false;
  const discovered = await discoverExposureCandidates({
    caseId: caseRecord.id,
    store,
    scope: caseRecord.redactedScope,
    pastedUrls: body.pastedUrls,
    existingUrls,
    brokerSweep,
    contentTakedown
  });
  for (const exposure of discovered) {
    store.exposures.set(exposure.id, exposure);
    await emitCaseWebhook(store, caseRecord.id, "exposure.discovered", {
      exposureId: exposure.id,
      sourceUrl: exposure.sourceUrl,
      matchScore: exposure.matchScore
    });
  }
  return {
    discovered,
    discovery: discoveryReadinessMessage(),
    discoveryPlan: describeDiscoveryPlan({
      scope: caseRecord.redactedScope,
      pastedUrlCount: body.pastedUrls?.length ?? 0,
      brokerSweep,
      contentTakedown
    })
  };
}

export function handleFindingDecision(
  store: MemoryStore,
  caseRecord: CaseRecord,
  findingId: string,
  decision: "confirmed" | "rejected",
  options: { notFoundError?: string; createTimeline?: boolean } = {}
) {
  const notFoundError = options.notFoundError ?? "finding-not-found";
  const exposure = store.exposures.get(findingId);
  if (!exposure || exposure.caseId !== caseRecord.id) {
    throw new HttpError(404, notFoundError);
  }
  const updated = applyFindingDecision(exposure, decision);
  store.exposures.set(updated.id, updated);
  let timeline;
  if (options.createTimeline !== false) {
    timeline = createTimelineEvent(
      caseRecord.id,
      "ScoutAgent",
      decision === "confirmed" ? "Match confirmed" : "Match rejected",
      redactText(updated.sourceUrl)
    );
    store.agentTimeline.set(timeline.id, timeline);
  }
  return { exposure: updated, timeline, status: buildStatus(store, caseRecord.id) };
}

export async function handleApprove(store: MemoryStore, approvalId: string, body: ApproveBody) {
  const approval = store.approvals.get(approvalId);
  if (!approval) throw new HttpError(404, "approval-not-found");
  if (!body.userConfirmation || body.userConfirmation.length < 8) {
    throw new HttpError(422, "user-confirmation-required");
  }
  approval.status = "approved";
  approval.approvedAt = new Date().toISOString();
  approval.userConfirmation = redactText(body.userConfirmation);
  for (const action of store.actions.values()) {
    if (action.approvalId === approval.id) action.executionStatus = "ready";
  }
  await emitCaseWebhook(store, approval.caseId, "approval.approved", { approvalId: approval.id });
  return { approval, caseId: approval.caseId };
}

export async function handleExecute(
  store: MemoryStore,
  actionId: string,
  body: ExecuteActionBody,
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>
) {
  const action = store.actions.get(actionId);
  if (!action) throw new HttpError(404, "action-not-found");
  const approval = store.approvals.get(action.approvalId);
  if (!approval) throw new HttpError(409, "approval-missing");
  const caseRecord = store.getCaseOrThrow(action.caseId);
  const decision = canExecuteWithApproval(approval);
  if (!decision.allowed) {
    action.executionStatus = "blocked";
    throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
  }
  const executed = await executeApprovedAction({
    store,
    action,
    approval,
    trustCenterConfig: await loadTrustCenterConfig(),
    walletAddress: body.walletAddress,
    operatorEmailRelay: caseRecord.casePreferences?.operatorEmailRelay !== false,
    handoff: body
  });
  action.executionStatus = resolveExecutionStatusAfterExecute(executed);
  action.executedAt = new Date().toISOString();
  action.executionRecord = executed.executionRecord;
  approval.status = "used";
  await emitCaseWebhook(store, action.caseId, "action.executed", {
    actionId: action.id,
    brokerId: action.brokerId,
    status: action.executionStatus,
    mode: executed.mode
  });
  return { action, approval, executed, caseRecord };
}

export async function handleAgentRunStep(
  store: MemoryStore,
  caseRecord: CaseRecord,
  trustCenterPath: string,
  options: { highAutonomy?: boolean } = {}
) {
  return handleAgentRun(store, caseRecord, trustCenterPath, options);
}