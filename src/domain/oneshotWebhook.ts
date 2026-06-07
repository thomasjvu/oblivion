import { createRelayerEvents } from "./hackathon.js";
import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";
import type { RelayerEvent, RelayerStatus } from "./types.js";

export interface OneShotWebhookPayload {
  eventName?: string;
  data?: {
    transactionExecutionId?: string;
    transactionId?: string;
    transactionReceipt?: {
      hash?: string;
      status?: number;
    };
    transactionExecutionMemo?: string;
  };
  signature?: string;
}

function mapWebhookEventName(eventName: string): RelayerStatus {
  const normalized = eventName.toLowerCase();
  if (normalized.includes("success")) return "confirmed";
  if (normalized.includes("fail") || normalized.includes("reject") || normalized.includes("revert")) {
    return "failed";
  }
  if (normalized.includes("relay") || normalized.includes("submit")) return "relayed";
  return "submitted";
}

function parseMemoContext(memo?: string): { caseId?: string; sessionId?: string; taskId?: string } {
  if (!memo) return {};
  try {
    const parsed = JSON.parse(memo) as Record<string, unknown>;
    return {
      caseId: typeof parsed.caseId === "string" ? parsed.caseId : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined
    };
  } catch {
    return {};
  }
}

export function relayerEventFromOneShotWebhook(input: {
  caseId: string;
  sessionId?: string;
  permissionId?: string;
  payload: OneShotWebhookPayload;
}): RelayerEvent {
  const data = input.payload.data ?? {};
  const memoContext = parseMemoContext(data.transactionExecutionMemo);
  const status = mapWebhookEventName(input.payload.eventName ?? "submitted");
  const txHash = data.transactionReceipt?.hash;
  const taskId = data.transactionExecutionId || data.transactionId || memoContext.taskId;
  const [event] = createRelayerEvents({
    caseId: input.caseId,
    sessionId: input.sessionId ?? memoContext.sessionId,
    permissionId: input.permissionId,
    status,
    txHash,
    payload: sanitizeForLog(input.payload) as Record<string, unknown>
  }).slice(-1);
  return {
    ...event,
    taskId,
    message: taskId
      ? `1Shot webhook ${status} for task ${redactText(taskId)}.`
      : `1Shot webhook ${status}.`
  };
}