import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAttestationProof } from "../../../domain/attestation.js";
import { buildPartnerRuntimeBadge } from "../../../domain/partnerRuntime.js";
import { buildTrustPrivacyResponse } from "../../../domain/trustPrivacy.js";
import { sendJson } from "../../http.js";
import type { V1Context } from "./context.js";

export async function handleV1TrustRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1Context
): Promise<boolean> {
  const { loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/v1/trust/attestation") {
    const config = await loadTrustCenterConfig();
    const fetchLive = url.searchParams.get("live") !== "0";
    sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/runtime") {
    sendJson(response, 200, await buildPartnerRuntimeBadge(loadTrustCenterConfig, url.searchParams.get("live") !== "0"));
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/privacy") {
    sendJson(response, 200, buildTrustPrivacyResponse("partner"));
    return true;
  }

  return false;
}