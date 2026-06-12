import type { IncomingMessage, ServerResponse } from "node:http";
import { requirePartnerAuth } from "../auth.js";
import { HttpError } from "../errors.js";
import { handleV1BillingRoutes } from "./v1/billing.js";
import { handleV1CaseRoutes } from "./v1/cases.js";
import { type V1Context } from "./v1/context.js";
import { handleV1MetaRoutes } from "./v1/meta.js";
import { handleV1PartnerRoutes } from "./v1/partner.js";
import { handleV1TrustRoutes } from "./v1/trust.js";
import { handleV1WebhookRoutes } from "./v1/webhooks.js";

export type { V1Context } from "./v1/context.js";

const publicRouteHandlers = [handleV1TrustRoutes, handleV1MetaRoutes] as const;

const partnerRouteHandlers = [
  handleV1PartnerRoutes,
  handleV1BillingRoutes,
  handleV1WebhookRoutes,
  handleV1CaseRoutes
] as const;

export async function handleV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1Context
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/")) return false;

  for (const handler of publicRouteHandlers) {
    if (await handler(request, response, url, context)) {
      return true;
    }
  }

  const partner = requirePartnerAuth(request, context.store);
  const partnerContext = { ...context, partner };

  for (const handler of partnerRouteHandlers) {
    if (await handler(request, response, url, partnerContext)) {
      return true;
    }
  }

  throw new HttpError(404, "not-found");
}