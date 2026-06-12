import type { IncomingMessage, ServerResponse } from "node:http";
import { CLEANUP_PRESETS } from "../../../domain/cleanup.js";
import { listPartnerDataAccess } from "../../../domain/partnerAudit.js";
import { partnerBillingView, partnerUsageSummary } from "../../../domain/partnerBilling.js";
import { partnerPresetAllowlist, rotatePartnerApiKey } from "../../../domain/partners.js";
import { sendJson } from "../../http.js";
import type { V1PartnerContext } from "./context.js";

export async function handleV1PartnerRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1PartnerContext
): Promise<boolean> {
  const { store, partner } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/v1/partners/me") {
    sendJson(response, 200, {
      partner: {
        id: partner.id,
        name: partner.name,
        environment: partner.environment,
        balanceCredits: partner.balanceCredits,
        webhookUrl: partner.webhookUrl ?? null,
        webhookEvents: partner.webhookEvents,
        keyRotatedAt: partner.keyRotatedAt ?? null
      },
      billing: partnerBillingView(partner)
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/partners/me/rotate-key") {
    const rotated = rotatePartnerApiKey(partner);
    store.partners.set(partner.id, rotated.partner);
    sendJson(response, 200, {
      partnerId: rotated.partner.id,
      environment: rotated.partner.environment,
      apiKey: rotated.apiKey,
      keyRotatedAt: rotated.partner.keyRotatedAt,
      warning: "Store this key now. It will not be shown again."
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/presets") {
    const allowlist = partnerPresetAllowlist();
    sendJson(response, 200, {
      presets: CLEANUP_PRESETS.filter((preset) => allowlist.has(preset.id))
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/usage") {
    sendJson(response, 200, partnerUsageSummary(store, partner.id));
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/data-access") {
    const caseId = url.searchParams.get("caseId") ?? undefined;
    const limit = Number(url.searchParams.get("limit") || "50");
    sendJson(response, 200, {
      events: listPartnerDataAccess(store, partner.id, { caseId, limit })
    });
    return true;
  }

  return false;
}