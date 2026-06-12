import type { IncomingMessage, ServerResponse } from "node:http";
import type { PartnerWebhookEvent } from "../../../domain/types.js";
import {
  dispatchPartnerWebhook,
  partnerWebhookInboxUrl,
  processDueWebhookRetries,
  retryFailedWebhookDeliveries,
  retryWebhookDelivery
} from "../../../domain/webhooks.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import { apiBaseFromRequest, type V1PartnerContext, type WebhookBody } from "./context.js";

export async function handleV1WebhookRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1PartnerContext
): Promise<boolean> {
  const { store, partner } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/v1/webhooks") {
    const body = await readJson<WebhookBody>(request);
    if (!body.url?.startsWith("https://")) throw new HttpError(422, "webhook-url-https-required");
    partner.webhookUrl = body.url.trim();
    partner.webhookSecret = body.secret?.trim() || partner.webhookSecret || partner.id;
    if (Array.isArray(body.events) && body.events.length > 0) {
      partner.webhookEvents = body.events as typeof partner.webhookEvents;
    }
    partner.updatedAt = new Date().toISOString();
    store.partners.set(partner.id, partner);
    sendJson(response, 200, {
      partnerId: partner.id,
      webhookUrl: partner.webhookUrl,
      webhookEvents: partner.webhookEvents
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/webhooks/deliveries") {
    await processDueWebhookRetries(store);
    const statusFilter = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") || "50");
    const deliveries = [...store.webhookDeliveries.values()]
      .filter((delivery) => delivery.partnerId === partner.id)
      .filter((delivery) => (statusFilter ? delivery.status === statusFilter : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((delivery) => ({
        id: delivery.id,
        event: delivery.event,
        caseId: delivery.caseId,
        status: delivery.status,
        attemptCount: delivery.attemptCount ?? 1,
        nextRetryAt: delivery.nextRetryAt ?? null,
        responseStatus: delivery.responseStatus,
        error: delivery.error,
        createdAt: delivery.createdAt,
        deliveredAt: delivery.deliveredAt
      }));
    sendJson(response, 200, { deliveries });
    return true;
  }

  const deliveryRetryMatch = pathname.match(/^\/v1\/webhooks\/deliveries\/([^/]+)\/retry$/);
  if (method === "POST" && deliveryRetryMatch) {
    const delivery = await retryWebhookDelivery(store, partner, deliveryRetryMatch[1]);
    sendJson(response, 200, { delivery });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/deliveries/retry-failed") {
    const body = await readJson<{ limit?: number }>(request);
    const deliveries = await retryFailedWebhookDeliveries(store, partner, body.limit ?? 10);
    sendJson(response, 200, { retried: deliveries.length, deliveries });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/register-inbox") {
    const apiBase = apiBaseFromRequest(request);
    partner.webhookUrl = partnerWebhookInboxUrl(partner.id, apiBase);
    partner.webhookSecret = partner.webhookSecret ?? partner.id;
    partner.updatedAt = new Date().toISOString();
    store.partners.set(partner.id, partner);
    sendJson(response, 200, {
      partnerId: partner.id,
      webhookUrl: partner.webhookUrl,
      note: "Webhook deliveries will appear in GET /v1/partners/me/webhook-inbox"
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/test") {
    const body = await readJson<{ event?: PartnerWebhookEvent; caseId?: string }>(request);
    const event = body.event ?? "case.created";
    const delivery = await dispatchPartnerWebhook(store, partner, event, {
      caseId: body.caseId,
      test: true
    });
    sendJson(response, 200, { delivery: delivery ?? null, configured: Boolean(partner.webhookUrl) });
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/webhook-inbox") {
    const entries = [...store.partnerWebhookInbox.values()]
      .filter((entry) => entry.partnerId === partner.id)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, 50);
    sendJson(response, 200, { entries });
    return true;
  }

  return false;
}