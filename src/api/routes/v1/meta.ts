import type { IncomingMessage, ServerResponse } from "node:http";
import type { PartnerWebhookEvent } from "../../../domain/types.js";
import {
  storeWebhookInboxEntry,
  verifyWebhookSignature
} from "../../../domain/webhooks.js";
import { creditPartnerPool } from "../../../domain/partnerBilling.js";
import { HttpError } from "../../errors.js";
import { readJson, readRawBody, sendJson } from "../../http.js";
import type { V1Context } from "./context.js";

export async function handleV1MetaRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1Context
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  const inboxPostMatch = pathname.match(/^\/v1\/partners\/([^/]+)\/webhook-inbox$/);
  if (method === "POST" && inboxPostMatch) {
    const partner = store.partners.get(inboxPostMatch[1]);
    if (!partner) throw new HttpError(404, "partner-not-found");
    const rawBody = await readRawBody(request);
    const timestamp = String(request.headers["x-oblivion-timestamp"] ?? "");
    const signature = String(request.headers["x-oblivion-signature"] ?? "");
    const event = String(request.headers["x-oblivion-event"] ?? "case.created") as PartnerWebhookEvent;
    const secret = partner.webhookSecret ?? partner.id;
    const signatureValid = verifyWebhookSignature(secret, timestamp, rawBody, signature);
    if (!signatureValid) throw new HttpError(401, "webhook-signature-invalid");
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid-webhook-json");
    }
    const entry = storeWebhookInboxEntry(store, partner.id, event, payload, signatureValid);
    sendJson(response, 200, { received: true, id: entry.id });
    return true;
  }

  if (method === "GET" && pathname === "/v1/openapi.json") {
    sendJson(response, 200, {
      redirect: "/docs/openapi-v1.yaml",
      note: "See https://oblivion-docs.phantasy.bot/docs/developers/partner-api"
    });
    return true;
  }

  const adminCreditMatch = pathname.match(/^\/v1\/admin\/partners\/([^/]+)\/credits$/);
  if (method === "POST" && adminCreditMatch) {
    const adminToken = process.env.OBLIVION_PARTNER_ADMIN_TOKEN?.trim();
    const provided = String(request.headers["x-oblivion-admin-token"] ?? "");
    if (!adminToken || provided !== adminToken) throw new HttpError(401, "admin-token-required");
    const target = store.partners.get(adminCreditMatch[1]);
    if (!target) throw new HttpError(404, "partner-not-found");
    const body = await readJson<{ credits?: number }>(request);
    if (!body.credits) throw new HttpError(422, "credits-required");
    creditPartnerPool(store, target, body.credits);
    sendJson(response, 200, { partnerId: target.id, balanceCredits: target.balanceCredits });
    return true;
  }

  return false;
}