import type { IncomingMessage, ServerResponse } from "node:http";
import { deleteCaseRecord, exportCaseBundle } from "../../handlers/caseLifecycle.js";
import { recordPartnerDataAccess } from "../../../domain/partnerAudit.js";
import { assertCaseExportAllowed, resolvePartnerAuth } from "../../auth.js";
import { readJson, sendJson } from "../../http.js";
import type { CaseBody, ConsumerContext } from "./context.js";

export async function handleConsumerExportRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "POST" && url.pathname === "/api/export") {
    const body = await readJson<CaseBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    assertCaseExportAllowed(request, store, caseRecord);
    if (caseRecord.partnerId) {
      const partner = resolvePartnerAuth(request, store);
      if (partner) {
        recordPartnerDataAccess(store, {
          partnerId: partner.id,
          caseId: caseRecord.id,
          action: "export",
          source: "api"
        });
      }
    }
    sendJson(response, 200, exportCaseBundle(store, caseRecord));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/delete") {
    const body = await readJson<CaseBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    assertCaseExportAllowed(request, store, caseRecord);
    const partner = caseRecord.partnerId ? resolvePartnerAuth(request, store) ?? undefined : undefined;
    const result = await deleteCaseRecord(store, caseRecord, {
      partner,
      emitWebhook: Boolean(caseRecord.partnerId),
      auditSource: "api"
    });
    sendJson(response, 200, result);
    return true;
  }

  return false;
}