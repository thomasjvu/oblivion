import type { TrustCenterConfig } from "./attestation.js";
import { connectorIdForAction, runLiveConnector } from "./connectorRuntime.js";
import { isLiveExecutorEnabled } from "./integrations.js";
import { canExecuteWithApproval } from "./policy.js";
import type { ActionRequest, Approval, ConnectorResult } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { sourceVerificationFor } from "./sourceVerification.js";
import { HttpError } from "../api/errors.js";

export interface ExecuteActionInput {
  store: MemoryStore;
  action: ActionRequest;
  approval: Approval;
  trustCenterConfig: TrustCenterConfig;
  walletAddress?: string;
  operatorEmailRelay?: boolean;
  handoff?: {
    hashPrefix?: string;
    emailLabel?: string;
    sourceUrl?: string;
  };
}

export interface ExecuteActionResult {
  mode: "record-only" | "live";
  executionRecord: string;
  connectorResult?: ConnectorResult;
}

export function resolveExecutionStatusAfterExecute(input: {
  mode: ExecuteActionResult["mode"];
  connectorResult?: ConnectorResult;
}): ActionRequest["executionStatus"] {
  if (input.connectorResult?.status === "failed") return "failed";
  if (input.mode === "live" && input.connectorResult) return "executed";
  return "recorded";
}

export interface ExecuteApprovedActionFlowInput {
  store: MemoryStore;
  action: ActionRequest;
  approval: Approval;
  trustCenterConfig: TrustCenterConfig;
  walletAddress?: string;
  operatorEmailRelay?: boolean;
  handoff?: ExecuteActionInput["handoff"];
  blockActionOnDeny?: boolean;
}

export async function executeApprovedActionFlow(input: ExecuteApprovedActionFlowInput): Promise<ExecuteActionResult> {
  const decision = canExecuteWithApproval(input.approval);
  if (!decision.allowed) {
    if (input.blockActionOnDeny) {
      input.action.executionStatus = "blocked";
    }
    throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
  }
  const executed = await executeApprovedAction({
    store: input.store,
    action: input.action,
    approval: input.approval,
    trustCenterConfig: input.trustCenterConfig,
    walletAddress: input.walletAddress,
    operatorEmailRelay: input.operatorEmailRelay,
    handoff: input.handoff
  });
  input.action.executionStatus = resolveExecutionStatusAfterExecute(executed);
  input.action.executedAt = new Date().toISOString();
  input.action.executionRecord = executed.executionRecord;
  input.approval.status = "used";
  return executed;
}

export async function executeApprovedAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  if (!isLiveExecutorEnabled()) {
    if (input.action.actionType === "broker-opt-out") {
      markExposuresSubmitted(input.store, input.action.caseId, input.action.exposureId);
    }
    return {
      mode: "record-only",
      executionRecord:
        "record-only executor: approved action recorded. Production profile runs live connectors after TEE pass."
    };
  }

  const connectorId = connectorIdForAction(input.action.actionType, input.action.brokerId);
  const source = sourceVerificationFor(connectorId);
  if (!source?.claimVerified) {
    return {
      mode: "live",
      executionRecord: `live executor blocked: source verification missing for ${connectorId}.`
    };
  }

  const output = await runLiveConnector({
    action: input.action,
    approval: input.approval,
    trustCenterConfig: input.trustCenterConfig,
    store: input.store,
    walletAddress: input.walletAddress,
    operatorEmailRelay: input.operatorEmailRelay,
    handoff: input.handoff
  });
  input.store.connectorResults.set(output.result.id, output.result);
  recordSourceCheck(input.store, input.action.caseId, connectorId);
  if (input.action.actionType === "broker-opt-out") {
    markExposuresSubmitted(input.store, input.action.caseId, input.action.exposureId);
  }
  if (input.action.actionType === "dmca-takedown" || input.action.actionType === "platform-abuse-report") {
    markExposuresSubmitted(input.store, input.action.caseId, input.action.exposureId);
  }
  return {
    mode: "live",
    executionRecord: output.executionRecord,
    connectorResult: output.result
  };
}

function markExposuresSubmitted(store: MemoryStore, caseId: string, exposureId?: string): void {
  for (const exposure of store.exposuresForCase(caseId)) {
    if (exposure.matchStatus !== "confirmed") continue;
    if (exposureId && exposure.id !== exposureId) continue;
    store.exposures.set(exposure.id, {
      ...exposure,
      removalStatus: "submitted"
    });
  }
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