import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handlePartnerRuntimeBadge,
  handleTrustAttestation,
  handleTrustPrivacy
} from "../../handlers/trustHandlers.js";
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
  const fetchLive = url.searchParams.get("live") !== "0";

  if (method === "GET" && pathname === "/v1/trust/attestation") {
    sendJson(response, 200, await handleTrustAttestation(loadTrustCenterConfig, fetchLive));
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/runtime") {
    sendJson(response, 200, await handlePartnerRuntimeBadge(loadTrustCenterConfig, fetchLive));
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/privacy") {
    sendJson(response, 200, handleTrustPrivacy("partner"));
    return true;
  }

  return false;
}