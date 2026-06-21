import type { IncomingMessage, ServerResponse } from "node:http";
import { createTimelineEvent } from "../../../../domain/agentTimeline.js";
import { isOneShotConfigured, oneShotWebhookDestinationUrl } from "../../../../domain/integrations.js";
import { callOneShotRpc, relayOneShotForCase } from "../../../../domain/oneshot.js";
import { assertOneShotRpcMethodAllowed } from "../../../../domain/oneshotRpc.js";
import {
  relayerEventFromOneShotWebhook,
  type OneShotWebhookPayload
} from "../../../../domain/oneshotWebhook.js";
import {
  resolveOneShotWebhookSession,
  verifyOneShotWebhookSignature
} from "../../../../domain/oneshotWebhookAuth.js";
import { getCaseWithAccess } from "../../../auth.js";
import { HttpError } from "../../../errors.js";
import { readJson, sendJson } from "../../../http.js";
import { type ConsumerContext, type RelayerBody } from "../context.js";

export async function handleIntegrationOneShotRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/1shot/webhook-url") {
    const caseId = url.searchParams.get("caseId");
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    const session = sessionId ? store.paymentSessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.caseId !== caseId)) {
      throw new HttpError(404, "payment-session-not-found");
    }
    sendJson(response, 200, {
      destinationUrl: oneShotWebhookDestinationUrl(caseId, sessionId, session?.oneShotWebhookToken)
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/rpc") {
    if (!isOneShotConfigured()) {
      throw new HttpError(503, "oneshot-not-configured");
    }
    const body = await readJson<{ caseId: string; method: string; params?: unknown }>(request);
    if (!body.caseId) throw new HttpError(422, "case-id-required");
    if (!body.method) throw new HttpError(422, "oneshot-method-required");
    getCaseWithAccess(request, store, body.caseId);
    try {
      assertOneShotRpcMethodAllowed(body.method);
    } catch {
      throw new HttpError(403, "oneshot-rpc-method-not-allowed");
    }
    const result = await callOneShotRpc(body.method, body.params);
    sendJson(response, 200, { result });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/relay") {
    if (!isOneShotConfigured()) {
      throw new HttpError(503, "oneshot-not-configured", {
        message: "Set ONESHOT_BASE_URL (default public relayer) and optional ONESHOT_API_KEY / ONESHOT_AUTHORIZATION."
      });
    }
    const body = await readJson<RelayerBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const session = body.sessionId ? store.paymentSessions.get(body.sessionId) : undefined;
    const destinationUrl =
      body.destinationUrl ||
      (body.sessionId
        ? oneShotWebhookDestinationUrl(body.caseId, body.sessionId, session?.oneShotWebhookToken)
        : undefined);
    const relay = await relayOneShotForCase({ ...body, destinationUrl });
    relay.events.forEach((event) => store.relayerEvents.set(event.id, event));
    if (relay.taskId && body.sessionId) {
      const session = store.paymentSessions.get(body.sessionId);
      if (session && session.caseId === caseRecord.id) {
        store.paymentSessions.set(session.id, {
          ...session,
          relayerTaskId: relay.taskId,
          updatedAt: new Date().toISOString()
        });
      }
    }
    const timeline = createTimelineEvent(
      caseRecord.id,
      "1Shot",
      "Relayer status",
      `1Shot relay: ${relay.events.at(-1)?.status ?? "submitted"}`
    );
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 201, { events: relay.events, taskId: relay.taskId, timeline });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/webhook") {
    const caseId = url.searchParams.get("caseId");
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const token = url.searchParams.get("token") ?? undefined;
    if (!caseId) throw new HttpError(422, "case-id-required");
    const session = resolveOneShotWebhookSession(store, caseId, sessionId, token);
    if (!session) throw new HttpError(401, "oneshot-webhook-unauthorized");
    const caseRecord = store.getCaseOrThrow(caseId);
    const body = await readJson<OneShotWebhookPayload>(request);
    if (!verifyOneShotWebhookSignature(body.signature)) {
      throw new HttpError(401, "oneshot-webhook-signature-invalid");
    }
    const event = relayerEventFromOneShotWebhook({
      caseId: caseRecord.id,
      sessionId,
      payload: body
    });
    store.relayerEvents.set(event.id, event);
    if (event.taskId && sessionId) {
      const session = store.paymentSessions.get(sessionId);
      if (session && session.caseId === caseRecord.id) {
        store.paymentSessions.set(session.id, {
          ...session,
          relayerTaskId: event.taskId,
          updatedAt: new Date().toISOString()
        });
      }
    }
    const timeline = createTimelineEvent(caseRecord.id, "1Shot", "Webhook status", event.message);
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 202, { event, timeline });
    return true;
  }

  return false;
}