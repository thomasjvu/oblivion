import { redactText } from "./redaction.js";
import type { AgentTimelineEvent, RelayerEvent, RelayerStatus } from "./types.js";

export function createTimelineEvent(
  caseId: string,
  actor: AgentTimelineEvent["actor"],
  title: string,
  summary: string
): AgentTimelineEvent {
  return {
    id: `timeline_${crypto.randomUUID()}`,
    caseId,
    actor,
    title,
    summary: redactText(summary),
    createdAt: new Date().toISOString()
  };
}

export function createRelayerEvents(input: {
  caseId: string;
  sessionId?: string;
  permissionId?: string;
  status?: RelayerStatus;
  txHash?: string;
  userOpHash?: string;
  payload?: Record<string, unknown>;
}): RelayerEvent[] {
  const txHash = input.txHash;
  const userOpHash = input.userOpHash;
  let sequence: RelayerStatus[] =
    input.status && input.status === "failed" ? ["submitted", "failed"] : ["submitted", "relayed", "confirmed"];
  if (!txHash && sequence.includes("confirmed")) {
    sequence = input.status === "failed" ? ["submitted", "failed"] : ["submitted"];
  }
  return sequence.map((status) => ({
    id: `relayer_${crypto.randomUUID()}`,
    caseId: input.caseId,
    provider: "1shot",
    eventType: status,
    status,
    txHash,
    userOpHash,
    message: status === "confirmed" ? "1Shot relay confirmed for the case-bound permission." : `1Shot relay ${status}.`,
    payload: input.payload,
    createdAt: new Date().toISOString()
  }));
}