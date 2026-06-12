import type { IncomingMessage, ServerResponse } from "node:http";
import { meterVeniceAnalysis } from "../../../handlers/veniceMeter.js";
import { getCaseWithAccess } from "../../../auth.js";
import { readJson, sendJson } from "../../../http.js";
import { type ConsumerContext, type VeniceBody } from "../context.js";

export async function handleIntegrationVeniceRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (
    method === "POST" &&
    ["/api/ai/classify-case", "/api/ai/draft-request", "/api/ai/review-approval"].includes(url.pathname)
  ) {
    const body = await readJson<VeniceBody & { walletAddress?: string }>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const kind =
      url.pathname === "/api/ai/draft-request"
        ? "draft-request"
        : url.pathname === "/api/ai/review-approval"
          ? "review-approval"
          : "classify-case";
    const result = await meterVeniceAnalysis(store, caseRecord, {
      kind,
      walletAddress: body.walletAddress,
      notes: body.notes,
      destination: body.destination,
      actionType: body.actionType
    });
    sendJson(response, 201, result);
    return true;
  }

  return false;
}