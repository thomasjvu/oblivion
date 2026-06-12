import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createPaymentPermission,
  createPaymentSession,
  createTimelineEvent,
  X402_PRODUCTS
} from "../../../domain/hackathon.js";
import {
  applyX402HttpResult,
  markSessionPaid,
  processX402Request,
  settleX402Payment,
  x402PublicConfig
} from "../../../domain/x402.js";
import {
  creditRates,
  MONITOR_MONTHLY_CREDITS,
  resolveCreditsView,
  settleCreditsForProduct,
  STARTER_PACK_CREDITS
} from "../../../domain/credits.js";
import { isX402Configured } from "../../../domain/integrations.js";
import { markCaseActivated } from "../../../domain/caseActivation.js";
import type { PaymentMode } from "../../../domain/types.js";
import { getCaseWithAccess } from "../../auth.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import type { ConsumerContext, CreditsPurchaseBody, PaymentBody } from "./context.js";

export async function handleConsumerPaymentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/x402/products") {
    sendJson(response, 200, {
      products: X402_PRODUCTS,
      config: x402PublicConfig(),
      credits: creditRates(),
      note: isX402Configured()
        ? "Live x402 catalog. Pay $5 USDC for 500 credits or $10 USDC/month for 1,200 credits via x402."
        : "Configure X402_PAY_TO and X402_FACILITATOR_URL for live HTTP 402 settlement."
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/x402/config") {
    sendJson(response, 200, x402PublicConfig());
    return true;
  }

  if (method === "POST" && (url.pathname === "/api/x402/one-off" || url.pathname === "/api/x402/subscription")) {
    if (!isX402Configured()) {
      throw new HttpError(503, "x402-not-configured", {
        message: "Set X402_PAY_TO and X402_FACILITATOR_URL for payment sessions."
      });
    }
    const mode: PaymentMode = url.pathname.endsWith("subscription") ? "subscription" : "one-off";
    const body = await readJson<PaymentBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    const session = createPaymentSession({
      caseId: caseRecord.id,
      mode,
      productId: body.productId || (mode === "subscription" ? "credit-monitor" : "credit-starter"),
      walletAddress: body.walletAddress,
      smartAccountAddress: body.smartAccountAddress
    });
    const permission = createPaymentPermission(caseRecord.id, session);
    store.paymentSessions.set(session.id, session);
    store.permissionGrants.set(permission.id, permission);
    const timeline = createTimelineEvent(
      caseRecord.id,
      "x402",
      mode === "subscription" ? "Subscription payment prepared" : "One-off payment prepared",
      `${session.productId} requires ERC-7710 scoped payment permission before execution.`
    );
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 201, { session, permission, timeline });
    return true;
  }

  if (method === "POST" && (url.pathname === "/api/credits/purchase" || url.pathname === "/api/credits/monitor")) {
    const body = await readJson<CreditsPurchaseBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    const expectedMode: PaymentMode = url.pathname.endsWith("monitor") ? "subscription" : "one-off";
    if (isX402Configured()) {
      const x402Result = await processX402Request({ request, url });
      if (x402Result?.type === "payment-error" && x402Result.response) {
        applyX402HttpResult(response, x402Result);
        return true;
      }
      if (x402Result?.type === "payment-verified") {
        const settlement = await settleX402Payment({ request, url, verified: x402Result });
        if (!settlement.ok) {
          throw new HttpError(402, "x402-settlement-failed", { error: settlement.error });
        }
        const sessions = store.paymentSessionsForCase(caseRecord.id);
        const session = body.paymentSessionId
          ? store.paymentSessions.get(body.paymentSessionId)
          : sessions.find((item) => item.mode === expectedMode && item.walletKey);
        if (session && session.caseId === caseRecord.id) {
          const paid = markSessionPaid(session, settlement.transaction);
          store.paymentSessions.set(paid.id, paid);
          markCaseActivated(store, caseRecord.id, paid);
        }
        const credits = settleCreditsForProduct(store, body.walletAddress, expectedMode, caseRecord.id);
        const timeline = createTimelineEvent(
          caseRecord.id,
          "x402",
          expectedMode === "subscription" ? "Monitor credits refilled via x402" : "Starter credits purchased via x402",
          `Wallet credited ${expectedMode === "subscription" ? MONITOR_MONTHLY_CREDITS : STARTER_PACK_CREDITS} credits.`
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 200, {
          entitlement: "credits-settled",
          settlement,
          session,
          credits: resolveCreditsView(store, body.walletAddress),
          balanceCredits: credits.balanceCredits,
          nextRequired: "metered-apis-require-credits",
          timeline
        });
        return true;
      }
    }
    const sessions = store.paymentSessionsForCase(caseRecord.id);
    const session = body.paymentSessionId
      ? store.paymentSessions.get(body.paymentSessionId)
      : sessions.find((item) => item.mode === expectedMode);
    if (!session || session.caseId !== caseRecord.id || session.mode !== expectedMode) {
      throw new HttpError(402, "x402-payment-required", {
        products: X402_PRODUCTS.filter((product) => product.mode === expectedMode),
        config: x402PublicConfig(),
        rates: creditRates()
      });
    }
    const paid = markSessionPaid(session);
    store.paymentSessions.set(paid.id, paid);
    markCaseActivated(store, caseRecord.id, paid);
    const credits = settleCreditsForProduct(store, body.walletAddress, expectedMode, caseRecord.id);
    const timeline = createTimelineEvent(
      caseRecord.id,
      "x402",
      expectedMode === "subscription" ? "Monitor credits refilled" : "Starter credits purchased",
      `Wallet credited ${expectedMode === "subscription" ? MONITOR_MONTHLY_CREDITS : STARTER_PACK_CREDITS} credits.`
    );
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 200, {
      entitlement: "credits-settled",
      session,
      credits: resolveCreditsView(store, body.walletAddress),
      balanceCredits: credits.balanceCredits,
      nextRequired: "metered-apis-require-credits",
      timeline
    });
    return true;
  }

  return false;
}