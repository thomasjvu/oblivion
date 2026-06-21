import type { MemoryStore } from "../storage/memoryStore.js";

function purgeIndexed<T extends { id: string }>(
  store: MemoryStore,
  map: { valuesForCase(caseId: string): T[]; delete(id: string): boolean },
  caseId: string
): void {
  for (const item of map.valuesForCase(caseId)) {
    map.delete(item.id);
  }
}

export function purgeCaseData(store: MemoryStore, caseId: string): void {
  purgeIndexed(store, store.approvals, caseId);
  purgeIndexed(store, store.actions, caseId);
  purgeIndexed(store, store.exposures, caseId);
  purgeIndexed(store, store.sourceChecks, caseId);
  purgeIndexed(store, store.followUps, caseId);
  purgeIndexed(store, store.paymentSessions, caseId);
  purgeIndexed(store, store.permissionGrants, caseId);
  purgeIndexed(store, store.relayerEvents, caseId);
  purgeIndexed(store, store.veniceAnalyses, caseId);
  purgeIndexed(store, store.agentDelegations, caseId);
  purgeIndexed(store, store.agentMessages, caseId);
  purgeIndexed(store, store.agentTimeline, caseId);
  purgeIndexed(store, store.agentPlans, caseId);
  purgeIndexed(store, store.connectorResults, caseId);
}