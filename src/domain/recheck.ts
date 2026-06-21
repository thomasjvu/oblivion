import { createTimelineEvent } from "./agentTimeline.js";
import { brokerCatalogEntryById } from "./brokerCatalog.js";
import { discoverExposureCandidates } from "./exposureDiscovery.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { CaseRecord, Exposure, FollowUp, FollowUpStatus } from "./types.js";
import { emitCaseWebhook } from "./webhooks.js";

export function followUpStatus(followUp: FollowUp): FollowUpStatus {
  return followUp.status ?? "pending";
}

export function findDueFollowUps(store: MemoryStore, caseId?: string): FollowUp[] {
  const now = Date.now();
  return [...store.followUps.values()]
    .filter((followUp) => (caseId ? followUp.caseId === caseId : true))
    .filter((followUp) => followUpStatus(followUp) === "pending")
    .filter((followUp) => Date.parse(followUp.dueDate) <= now)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export async function discoverForRecheck(
  store: MemoryStore,
  caseRecord: CaseRecord,
  followUp: FollowUp
): Promise<Exposure[]> {
  const existingUrls = store.exposuresForCase(caseRecord.id).map((item) => item.sourceUrl);
  const discovered = await discoverExposureCandidates({
    caseId: caseRecord.id,
    store,
    scope: caseRecord.redactedScope,
    existingUrls,
    brokerSweep: true,
    contentTakedown: false
  });
  const scoped = discovered.filter((exposure) => {
    if (followUp.brokerId && exposure.brokerId !== followUp.brokerId) return false;
    if (followUp.exposureId) {
      const prior = store.exposures.get(followUp.exposureId);
      if (prior?.sourceUrl && exposure.sourceUrl !== prior.sourceUrl) return false;
    }
    return true;
  });
  for (const exposure of scoped) {
    store.exposures.set(exposure.id, exposure);
    await emitCaseWebhook(store, caseRecord.id, "exposure.discovered", {
      followUpId: followUp.id,
      exposureId: exposure.id,
      sourceUrl: exposure.sourceUrl,
      matchScore: exposure.matchScore,
      kind: "recheck"
    });
  }
  return scoped;
}

export async function triggerRecheckForFollowUp(
  store: MemoryStore,
  followUp: FollowUp
): Promise<FollowUp> {
  const updated: FollowUp = {
    ...followUp,
    status: "triggered",
    lastTriggeredAt: new Date().toISOString()
  };
  store.followUps.set(followUp.id, updated);
  const caseRecord = store.getCaseOrThrow(followUp.caseId);
  const rediscovered = await discoverForRecheck(store, caseRecord, followUp);
  await emitCaseWebhook(store, followUp.caseId, "recheck.due", {
    followUpId: followUp.id,
    dueDate: followUp.dueDate,
    brokerId: followUp.brokerId,
    brokerLabel: followUp.brokerLabel ?? (followUp.brokerId ? brokerCatalogEntryById(followUp.brokerId)?.brokerLabel : undefined),
    exposureId: followUp.exposureId,
    expectedResponseWindow: followUp.expectedResponseWindow,
    rediscoveredCount: rediscovered.length,
    kind: "overdue"
  });
  const timeline = createTimelineEvent(
    followUp.caseId,
    "SchedulerAgent",
    "Recheck due",
    followUp.brokerLabel
      ? `${followUp.brokerLabel} recheck window reached${rediscovered.length ? ` · ${rediscovered.length} new exposure(s)` : ""}.`
      : `Scheduled recheck window reached${rediscovered.length ? ` · ${rediscovered.length} new exposure(s)` : ""}.`
  );
  store.agentTimeline.set(timeline.id, timeline);
  return updated;
}

export async function runCaseRecheck(
  store: MemoryStore,
  caseId: string
): Promise<{ triggered: FollowUp[] }> {
  store.getCaseOrThrow(caseId);
  const due = findDueFollowUps(store, caseId);
  const triggered: FollowUp[] = [];
  for (const followUp of due) {
    triggered.push(await triggerRecheckForFollowUp(store, followUp));
  }
  return { triggered };
}

export async function processDueRechecks(store: MemoryStore): Promise<number> {
  const due = findDueFollowUps(store);
  for (const followUp of due) {
    await triggerRecheckForFollowUp(store, followUp);
  }
  if (due.length > 0) store.markDirty();
  return due.length;
}