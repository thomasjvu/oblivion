import type { TrustCenterConfig } from "./attestation.js";
import { connectorIdForAction, runLiveConnector } from "./connectorRuntime.js";
import { isLiveExecutorEnabled } from "./integrations.js";
import { canExecuteWithApproval } from "./policy.js";
import type { ActionRequest, Approval, ConnectorResult } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { sourceVerificationFor } from "./sourceVerification.js";
import { DomainError } from "./errors.js";

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
  if (input.connectorResult?.requiresUserHandoff) {
    return "ready";
  }
  if (input.mode === "live" && input.connectorResult) return "executed";
  return "recorded";
}

export function shouldConsumeApprovalAfterExecute(executed: ExecuteActionResult): boolean {
  if (executed.connectorResult?.requiresUserHandoff) return false;
  if (executed.mode === "live" && !executed.connectorResult) return false;
  return true;
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
  if (input.approval.status === "used") {
    throw new DomainError("approval-not-executable", 409);
  }
  if (input.action.executionStatus !== "ready") {
    if (input.action.executionStatus === "executing") {
      throw new DomainError("action-already-executing", 409);
    }
    if (input.action.executionStatus === "executed" || input.action.executionStatus === "recorded") {
      throw new DomainError("action-already-executed", 409);
    }
    throw new DomainError("action-not-ready", 409);
  }
  input.action.executionStatus = "executing";
  const decision = canExecuteWithApproval(input.approval);
  if (!decision.allowed) {
    input.action.executionStatus = "ready";
    if (input.blockActionOnDeny) {
      input.action.executionStatus = "blocked";
    }
    throw new DomainError("execution-blocked", 403, { reasons: decision.reasons });
  }
  try {
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
    if (shouldConsumeApprovalAfterExecute(executed)) {
      input.approval.status = "used";
    }
    return executed;
  } catch (error) {
    if (input.action.executionStatus === "executing") {
      input.action.executionStatus = "ready";
    }
    throw error;
  }
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
    throw new DomainError("connector-source-unverified", 503, { connectorId });
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