import type { TrustCenterConfig } from "./attestation.js";
import { runCleanupAgentStep } from "./agentRunner.js";
import { buildStatus } from "./orchestration.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { CaseRecord, CaseStatus } from "./types.js";
import { emitCaseWebhook, notifyCasePendingApprovals } from "./webhooks.js";

export interface RunUntilBlockedResult {
  iterations: number;
  stoppedBecause: "approval-required" | "blocked" | "complete" | "max-iterations";
  plan?: unknown;
  status: CaseStatus;
}

export async function runPartnerAgentUntilBlocked(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  trustCenterConfig: () => Promise<TrustCenterConfig>;
  maxIterations?: number;
  highAutonomy?: boolean;
}): Promise<RunUntilBlockedResult> {
  const maxIterations = input.maxIterations ?? 12;
  let iterations = 0;
  let lastResult: Awaited<ReturnType<typeof runCleanupAgentStep>> | undefined;

  while (iterations < maxIterations) {
    iterations += 1;
    const before = input.store.agentPlanForCase(input.caseRecord.id)?.currentStep;
    lastResult = await runCleanupAgentStep({
      store: input.store,
      caseRecord: input.caseRecord,
      trustCenterConfig: input.trustCenterConfig,
      highAutonomy: input.highAutonomy
    });
    const after = input.store.agentPlanForCase(input.caseRecord.id)?.currentStep;
    if (after && after !== before) {
      await emitCaseWebhook(input.store, input.caseRecord.id, "case.phase_changed", {
        currentStep: after,
        blockedReasons: lastResult.plan?.blockedReasons ?? []
      });
    }
    await notifyCasePendingApprovals(input.store, input.caseRecord.id);

    const status = buildStatus(input.store, input.caseRecord.id);
    if (status.approvalsNeeded.length > 0) {
      return {
        iterations,
        stoppedBecause: "approval-required",
        plan: lastResult.plan,
        status
      };
    }
    if ((lastResult.plan as { currentStep?: string } | null)?.currentStep === "complete") {
      return {
        iterations,
        stoppedBecause: "complete",
        plan: lastResult.plan,
        status
      };
    }
    if ((lastResult.plan?.blockedReasons?.length ?? 0) > 0 && lastResult.plan?.currentStep !== "request-approval") {
      return {
        iterations,
        stoppedBecause: "blocked",
        plan: lastResult.plan,
        status
      };
    }
  }

  const status = buildStatus(input.store, input.caseRecord.id);
  return {
    iterations,
    stoppedBecause: "max-iterations",
    plan: lastResult?.plan,
    status
  };
}

export function findPartnerCaseByExternalRef(
  store: MemoryStore,
  partnerId: string,
  externalRef: string
): CaseRecord | undefined {
  return [...store.cases.values()].find(
    (caseRecord) =>
      caseRecord.partnerId === partnerId &&
      caseRecord.externalRef === externalRef &&
      !caseRecord.deletedAt
  );
}