import type { MemoryStore } from "../storage/memoryStore.js";

export function purgeCaseData(store: MemoryStore, caseId: string): void {
  for (const [id, approval] of store.approvals) {
    if (approval.caseId === caseId) store.approvals.delete(id);
  }
  for (const [id, action] of store.actions) {
    if (action.caseId === caseId) store.actions.delete(id);
  }
  for (const [id, exposure] of store.exposures) {
    if (exposure.caseId === caseId) store.exposures.delete(id);
  }
  for (const [id, sourceCheck] of store.sourceChecks) {
    if (sourceCheck.caseId === caseId) store.sourceChecks.delete(id);
  }
  for (const [id, followUp] of store.followUps) {
    if (followUp.caseId === caseId) store.followUps.delete(id);
  }
  for (const [id, session] of store.paymentSessions) {
    if (session.caseId === caseId) store.paymentSessions.delete(id);
  }
  for (const [id, grant] of store.permissionGrants) {
    if (grant.caseId === caseId) store.permissionGrants.delete(id);
  }
  for (const [id, event] of store.relayerEvents) {
    if (event.caseId === caseId) store.relayerEvents.delete(id);
  }
  for (const [id, analysis] of store.veniceAnalyses) {
    if (analysis.caseId === caseId) store.veniceAnalyses.delete(id);
  }
  for (const [id, delegation] of store.agentDelegations) {
    if (delegation.caseId === caseId) store.agentDelegations.delete(id);
  }
  for (const [id, message] of store.agentMessages) {
    if (message.caseId === caseId) store.agentMessages.delete(id);
  }
  for (const [id, event] of store.agentTimeline) {
    if (event.caseId === caseId) store.agentTimeline.delete(id);
  }
  for (const [id, plan] of store.agentPlans) {
    if (plan.caseId === caseId) store.agentPlans.delete(id);
  }
  for (const [id, result] of store.connectorResults) {
    if (result.caseId === caseId) store.connectorResults.delete(id);
  }
}