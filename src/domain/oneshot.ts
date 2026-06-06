import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";
import { oneShotBaseUrl, oneShotDemoFallbackEnabled } from "./integrations.js";
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
  demo?: boolean;
}

export async function callOneShotRpc<T = unknown>(method: string, params?: unknown): Promise<T> {
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
    message: `1Shot ${event.status} for task ${redactText(input.taskId)}.`
  }));
}

export async function relayOneShotForCase(body: OneShotRelayBody): Promise<{ events: RelayerEvent[]; mode: "live" | "demo" }> {
  if (body.demo || (oneShotDemoFallbackEnabled() && !body.method && !body.taskId)) {
    const events = createRelayerEvents({
      caseId: body.caseId,
      sessionId: body.sessionId,
      permissionId: body.permissionId,
      status: body.status,
      txHash: body.txHash,
      userOpHash: body.userOpHash,
      payload: body.payload
    });
    return { events, mode: "demo" };
  }

  if (body.taskId) {
    const result = await callOneShotRpc<Record<string, unknown>>("relayer_getStatus", { taskId: body.taskId });
    const events = relayerEventsFromTask({
      caseId: body.caseId,
      taskId: body.taskId,
      statusPayload: result,
      sessionId: body.sessionId,
      permissionId: body.permissionId
    });
    return { events, mode: "live" };
  }

  if (body.method) {
    const result = await callOneShotRpc<Record<string, unknown>>(body.method, body.params);
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
      return { events, mode: "live" };
    }
    const status = await callOneShotRpc<Record<string, unknown>>("relayer_getStatus", { taskId });
    const events = relayerEventsFromTask({
      caseId: body.caseId,
      taskId,
      statusPayload: status,
      sessionId: body.sessionId,
      permissionId: body.permissionId
    });
    return { events, mode: "live" };
  }

  throw Object.assign(new Error("oneshot-relay-payload-required"), {
    statusCode: 422,
    message:
      "Provide taskId to poll status, or method + params (e.g. relayer_send7710Transaction) with the signed delegation bundle from the wallet."
  });
}