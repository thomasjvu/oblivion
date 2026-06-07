import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ActionRequest,
  AgentDelegation,
  AgentMessage,
  AgentPlan,
  AgentTimelineEvent,
  Approval,
  CaseRecord,
  ConnectorResult,
  Exposure,
  FollowUp,
  PaymentSession,
  PermissionGrant,
  RelayerEvent,
  SourceCheck,
  VeniceAnalysis
} from "../domain/types.js";
import { MemoryStore } from "./memoryStore.js";

interface PersistedStoreSnapshot {
  cases: CaseRecord[];
  approvals: Approval[];
  actions: ActionRequest[];
  exposures: Exposure[];
  sourceChecks: SourceCheck[];
  followUps: FollowUp[];
  paymentSessions: PaymentSession[];
  permissionGrants: PermissionGrant[];
  relayerEvents: RelayerEvent[];
  veniceAnalyses: VeniceAnalysis[];
  agentDelegations: AgentDelegation[];
  agentMessages: AgentMessage[];
  agentTimeline: AgentTimelineEvent[];
  agentPlans: AgentPlan[];
  connectorResults: ConnectorResult[];
  tombstones: Array<[string, string]>;
}

function entries<T extends { id: string }>(items: T[]): Array<[string, T]> {
  return items.map((item) => [item.id, item]);
}

export function loadFileStore(path: string): MemoryStore {
  const store = new MemoryStore();
  try {
    const raw = readFileSync(path, "utf8");
    const snapshot = JSON.parse(raw) as PersistedStoreSnapshot;
    snapshot.cases?.forEach((item) => store.cases.set(item.id, item));
    snapshot.approvals?.forEach((item) => store.approvals.set(item.id, item));
    snapshot.actions?.forEach((item) => store.actions.set(item.id, item));
    snapshot.exposures?.forEach((item) => store.exposures.set(item.id, item));
    snapshot.sourceChecks?.forEach((item) => store.sourceChecks.set(item.id, item));
    snapshot.followUps?.forEach((item) => store.followUps.set(item.id, item));
    snapshot.paymentSessions?.forEach((item) => store.paymentSessions.set(item.id, item));
    snapshot.permissionGrants?.forEach((item) => store.permissionGrants.set(item.id, item));
    snapshot.relayerEvents?.forEach((item) => store.relayerEvents.set(item.id, item));
    snapshot.veniceAnalyses?.forEach((item) => store.veniceAnalyses.set(item.id, item));
    snapshot.agentDelegations?.forEach((item) => store.agentDelegations.set(item.id, item));
    snapshot.agentMessages?.forEach((item) => store.agentMessages.set(item.id, item));
    snapshot.agentTimeline?.forEach((item) => store.agentTimeline.set(item.id, item));
    snapshot.agentPlans?.forEach((item) => store.agentPlans.set(item.id, item));
    snapshot.connectorResults?.forEach((item) => store.connectorResults.set(item.id, item));
    snapshot.tombstones?.forEach(([id, value]) => store.tombstones.set(id, value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return store;
}

export function snapshotStore(store: MemoryStore): PersistedStoreSnapshot {
  return {
    cases: [...store.cases.values()],
    approvals: [...store.approvals.values()],
    actions: [...store.actions.values()],
    exposures: [...store.exposures.values()],
    sourceChecks: [...store.sourceChecks.values()],
    followUps: [...store.followUps.values()],
    paymentSessions: [...store.paymentSessions.values()],
    permissionGrants: [...store.permissionGrants.values()],
    relayerEvents: [...store.relayerEvents.values()],
    veniceAnalyses: [...store.veniceAnalyses.values()],
    agentDelegations: [...store.agentDelegations.values()],
    agentMessages: [...store.agentMessages.values()],
    agentTimeline: [...store.agentTimeline.values()],
    agentPlans: [...store.agentPlans.values()],
    connectorResults: [...store.connectorResults.values()],
    tombstones: [...store.tombstones.entries()]
  };
}

let saveTimer: NodeJS.Timeout | null = null;

export function scheduleStorePersist(store: MemoryStore, path: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistStore(store, path);
  }, 300);
}

export function persistStore(store: MemoryStore, path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${path.split("/").pop() ?? "oblivion"}.tmp-${process.pid}`);
  writeFileSync(tempPath, JSON.stringify(snapshotStore(store), null, 2), "utf8");
  renameSync(tempPath, path);
}

export function createPersistentStore(path: string): MemoryStore {
  return loadFileStore(path);
}