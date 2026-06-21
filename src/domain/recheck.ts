import { createTimelineEvent } from "./agentTimeline.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { FollowUp, FollowUpStatus } from "./types.js";
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
  await emitCaseWebhook(store, followUp.caseId, "recheck.due", {
    followUpId: followUp.id,
    dueDate: followUp.dueDate,
    brokerId: followUp.brokerId,
    brokerLabel: followUp.brokerLabel,
    exposureId: followUp.exposureId,
    expectedResponseWindow: followUp.expectedResponseWindow,
    kind: "overdue"
  });
  const timeline = createTimelineEvent(
    followUp.caseId,
    "SchedulerAgent",
    "Recheck due",
    followUp.brokerLabel
      ? `${followUp.brokerLabel} recheck window reached.`
      : "Scheduled recheck window reached."
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
  return due.length;
}