import type { IncomingMessage, ServerResponse } from "node:http";
import { creditRates, resolveCreditsView } from "../../../domain/credits.js";
import type { CaseRecord } from "../../../domain/types.js";
import { casesForWallet, linkCaseToWallet } from "../../../domain/walletCases.js";
import { publicCaseView } from "../../../domain/cases.js";
import { getCaseWithAccess } from "../../auth.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import type { CasePreferencesBody, ConsumerContext } from "./context.js";

export async function handleConsumerWalletRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/wallet/cases") {
    const walletAddress = url.searchParams.get("walletAddress");
    if (!walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    sendJson(response, 200, { cases: casesForWallet(store, walletAddress) });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/wallet/cases/link") {
    const body = await readJson<{ caseId: string; walletAddress: string }>(request);
    if (!body.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    if (!body.caseId) throw new HttpError(422, "case-id-required");
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const updated = linkCaseToWallet(store, caseRecord, body.walletAddress);
    sendJson(response, 200, { case: publicCaseView(updated) });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/credits/balance") {
    const walletAddress = url.searchParams.get("walletAddress");
    if (!walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    sendJson(response, 200, resolveCreditsView(store, walletAddress));
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/api/cases/") && url.pathname.endsWith("/ai-entitlement")) {
    const caseId = url.pathname.split("/")[3];
    getCaseWithAccess(request, store, caseId);
    const walletAddress = url.searchParams.get("walletAddress");
    if (walletAddress?.startsWith("0x")) {
      sendJson(response, 200, resolveCreditsView(store, walletAddress));
      return true;
    }
    sendJson(response, 200, { balanceCredits: 0, rates: creditRates(), walletRequired: true });
    return true;
  }

  const preferencesMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/preferences$/);
  if (method === "PATCH" && preferencesMatch) {
    const caseRecord = getCaseWithAccess(request, store, preferencesMatch[1]);
    const body = await readJson<CasePreferencesBody>(request);
    const updated: CaseRecord = {
      ...caseRecord,
      casePreferences: { operatorEmailRelay: body.operatorEmailRelay !== false },
      updatedAt: new Date().toISOString()
    };
    store.cases.set(updated.id, updated);
    sendJson(response, 200, { case: publicCaseView(updated) });
    return true;
  }

  return false;
}