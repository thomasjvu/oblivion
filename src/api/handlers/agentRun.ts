import { loadTrustCenterConfigFromPath } from "../trustCenter.js";
import { runCleanupAgentStep } from "../../domain/agentRunner.js";
import { emitCaseWebhook, notifyCasePendingApprovals } from "../../domain/webhooks.js";
import type { CaseRecord } from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";

export async function handleAgentRun(
  store: MemoryStore,
  caseRecord: CaseRecord,
  trustCenterPath: string,
  options: { highAutonomy?: boolean } = {}
) {
  const beforeStep = store.agentPlanForCase(caseRecord.id)?.currentStep;
  const result = await runCleanupAgentStep({
    store,
    caseRecord,
    trustCenterConfig: () => loadTrustCenterConfigFromPath(trustCenterPath),
    highAutonomy: options.highAutonomy
  });
  const afterStep = store.agentPlanForCase(caseRecord.id)?.currentStep;
  if (afterStep && afterStep !== beforeStep) {
    await emitCaseWebhook(store, caseRecord.id, "case.phase_changed", {
      currentStep: afterStep,
      blockedReasons: result.plan?.blockedReasons ?? []
    });
  }
  await notifyCasePendingApprovals(store, caseRecord.id);
  return result;
}