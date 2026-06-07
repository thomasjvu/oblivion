import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";
import { oneShotBaseUrl, oneShotWebhookDestinationUrl } from "./integrations.js";
import type { RelayerEvent, RelayerStatus } from "./types.js";
import { createRelayerEvents } from "./hackathon.js";

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface OneShotRelayBody {
  caseId: string;
  sessionId?: string;
  permissionId?: string;
  taskId?: string;
  method?: string;
  params?: unknown;
  destinationUrl?: string;
  status?: RelayerStatus;
  txHash?: string;
  userOpHash?: string;
  payload?: Record<string, unknown>;
}

export function isOneShotDemoFallbackEnabled(): boolean {
  return process.env.ONESHOT_DEMO_FALLBACK === "true" && !process.env.ONESHOT_API_KEY?.trim();
}

export async function callOneShotRpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (isOneShotDemoFallbackEnabled()) {
    if (method === "relayer_getStatus") {
      return { status: "Confirmed", txHash: "0xdemo", userOpHash: "0xdemo" } as T;
    }
    return { TaskId: `demo_task_${crypto.randomUUID().slice(0, 8)}`, status: "submitted" } as T;
  }
  const url = oneShotBaseUrl();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = process.env.ONESHOT_API_KEY?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const authorization = process.env.ONESHOT_AUTHORIZATION?.trim();
  if (authorization) headers["x-1shot-authorization"] = authorization;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: params ?? []
    })
  });
  if (!response.ok) {
    throw Object.assign(new Error(`oneshot-http-${response.status}`), { statusCode: 502 });
  }
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw Object.assign(new Error(`oneshot-rpc-${json.error.code}`), {
      statusCode: 502,
      details: sanitizeForLog(json.error) as Record<string, unknown>
    });
  }
  return json.result as T;
}

function mapTerminalStatus(raw: string): RelayerStatus {
  const normalized = raw.toLowerCase();
  if (normalized.includes("confirm") || normalized === "success") return "confirmed";
  if (normalized.includes("relay")) return "relayed";
  if (normalized.includes("fail") || normalized.includes("reject") || normalized.includes("revert")) {
    return "failed";
  }
  return "submitted";
}

export function relayerEventsFromTask(input: {
  caseId: string;
  taskId: string;
  statusPayload: Record<string, unknown>;
  sessionId?: string;
  permissionId?: string;
}): RelayerEvent[] {
  const statusRaw = String(input.statusPayload.status ?? input.statusPayload.state ?? "submitted");
  const status = mapTerminalStatus(statusRaw);
  const txHash =
    typeof input.statusPayload.txHash === "string"
      ? input.statusPayload.txHash
      : typeof input.statusPayload.transactionHash === "string"
        ? input.statusPayload.transactionHash
        : undefined;
  const userOpHash =
    typeof input.statusPayload.userOpHash === "string" ? input.statusPayload.userOpHash : undefined;
  return createRelayerEvents({
    caseId: input.caseId,
    sessionId: input.sessionId,
    permissionId: input.permissionId,
    status,
    txHash,
    userOpHash,
    payload: sanitizeForLog(input.statusPayload) as Record<string, unknown>
  }).map((event) => ({
    ...event,
    taskId: input.taskId,
    message: `1Shot ${event.status} for task ${redactText(input.taskId)}.`
  }));
}

function injectRelayContext(
  body: OneShotRelayBody,
  params: Record<string, unknown> | unknown[]
): Record<string, unknown> | unknown[] {
  const destinationUrl =
    body.destinationUrl ||
    (body.sessionId ? oneShotWebhookDestinationUrl(body.caseId, body.sessionId) : undefined);
  if (Array.isArray(params)) return params;
  const record = { ...(params as Record<string, unknown>) };
  if (destinationUrl && record.destinationUrl === undefined) {
    record.destinationUrl = destinationUrl;
  }
  if (body.sessionId && record.memo === undefined) {
    record.memo = JSON.stringify({ caseId: body.caseId, sessionId: body.sessionId });
  }
  return record;
}

export async function relayOneShotForCase(body: OneShotRelayBody): Promise<{ events: RelayerEvent[]; taskId?: string }> {
  if (body.taskId) {
    const result = await callOneShotRpc<Record<string, unknown>>("relayer_getStatus", { taskId: body.taskId });
    const events = relayerEventsFromTask({
      caseId: body.caseId,
      taskId: body.taskId,
      statusPayload: result,
      sessionId: body.sessionId,
      permissionId: body.permissionId
    });
    return { events, taskId: body.taskId };
  }

  if (body.method) {
    const params = injectRelayContext(body, (body.params as Record<string, unknown>) ?? {});
    const result = await callOneShotRpc<Record<string, unknown>>(body.method, params);
    const taskId =
      typeof result.TaskId === "string"
        ? result.TaskId
        : typeof result.taskId === "string"
          ? result.taskId
          : Array.isArray(result.TaskId)
            ? result.TaskId[0]
            : undefined;
    if (!taskId) {
      const events = createRelayerEvents({
        caseId: body.caseId,
        sessionId: body.sessionId,
        permissionId: body.permissionId,
        status: "submitted",
        payload: sanitizeForLog(result) as Record<string, unknown>
      });
      return { events };
    }
    const status = await callOneShotRpc<Record<string, unknown>>("relayer_getStatus", { taskId });
    const events = relayerEventsFromTask({
      caseId: body.caseId,
      taskId,
      statusPayload: status,
      sessionId: body.sessionId,
      permissionId: body.permissionId
    });
    return { events, taskId };
  }

  throw Object.assign(new Error("oneshot-relay-payload-required"), {
    statusCode: 422,
    message:
      "Provide taskId to poll status, or method + params (e.g. relayer_send7710Transaction) with the signed delegation bundle from the wallet."
  });
}