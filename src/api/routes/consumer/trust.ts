import type { IncomingMessage, ServerResponse } from "node:http";
import { handleTrustAttestation, handleTrustPrivacy } from "../../handlers/trustHandlers.js";
import { sendJson } from "../../http.js";
import type { ConsumerContext } from "./context.js";

export async function handleConsumerTrustRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/trust/attestation") {
    const fetchLive = url.searchParams.get("live") !== "0";
    sendJson(response, 200, await handleTrustAttestation(loadTrustCenterConfig, fetchLive));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/trust/privacy") {
    sendJson(response, 200, handleTrustPrivacy("consumer"));
    return true;
  }

  return false;
}