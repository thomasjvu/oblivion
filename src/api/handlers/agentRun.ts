import { readFile } from "node:fs/promises";
import type { TrustCenterConfig } from "../../domain/attestation.js";
import { runCleanupAgentStep } from "../../domain/agentRunner.js";
import { emitCaseWebhook, notifyCasePendingApprovals } from "../../domain/webhooks.js";
import type { CaseRecord } from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";

async function loadTrustCenterConfig(trustCenterPath: string): Promise<TrustCenterConfig> {
  const config = JSON.parse(await readFile(trustCenterPath, "utf8")) as TrustCenterConfig;
  return {
    ...config,
    attestationReportUrl: process.env.PHALA_ATTESTATION_URL ?? config.attestationReportUrl ?? null,
    phalaVerifierEndpoint: process.env.PHALA_VERIFIER_ENDPOINT ?? config.phalaVerifierEndpoint ?? null,
    maxAttestationAgeSeconds: Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? config.maxAttestationAgeSeconds ?? 600)
  };
}

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
    trustCenterConfig: () => loadTrustCenterConfig(trustCenterPath),
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