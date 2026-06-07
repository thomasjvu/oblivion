import { apiRequest } from "./apiClient.js";

export async function fetchOneShotWebhookUrl(caseId, sessionId) {
  const params = new URLSearchParams({ caseId });
  if (sessionId) params.set("sessionId", sessionId);
  const result = await apiRequest(`/api/1shot/webhook-url?${params.toString()}`);
  return result.destinationUrl;
}

export async function callOneShotRpc(method, params) {
  const result = await apiRequest("/api/1shot/rpc", {
    method: "POST",
    body: { method, params }
  });
  return result.result;
}

export async function relayOneShot(input) {
  return apiRequest("/api/1shot/relay", {
    method: "POST",
    body: input
  });
}

export async function pollRelayTask(caseId, sessionId, taskId) {
  return relayOneShot({ caseId, sessionId, taskId });
}

export async function submitRelayBundle(caseId, sessionId, method, params, destinationUrl) {
  return relayOneShot({
    caseId,
    sessionId,
    method,
    params,
    destinationUrl
  });
}