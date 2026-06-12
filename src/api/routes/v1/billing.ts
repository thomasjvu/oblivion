import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closePartnerInvoicePeriod,
  getPartnerInvoice,
  invoiceView,
  listPartnerInvoices
} from "../../../domain/partnerInvoices.js";
import { partnerBillingView } from "../../../domain/partnerBilling.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import type { V1PartnerContext } from "./context.js";

export async function handleV1BillingRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1PartnerContext
): Promise<boolean> {
  const { store, partner } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/v1/billing/balance") {
    sendJson(response, 200, partnerBillingView(partner));
    return true;
  }

  if (method === "GET" && pathname === "/v1/billing/invoices") {
    sendJson(response, 200, {
      invoices: listPartnerInvoices(store, partner.id).map(invoiceView)
    });
    return true;
  }

  const invoiceMatch = pathname.match(/^\/v1\/billing\/invoices\/([^/]+)$/);
  if (method === "GET" && invoiceMatch) {
    const invoice = getPartnerInvoice(store, partner.id, invoiceMatch[1]);
    sendJson(response, 200, { invoice: invoiceView(invoice) });
    return true;
  }

  if (method === "POST" && pathname === "/v1/billing/invoices/close") {
    const body = await readJson<{ period?: string }>(request);
    if (!body.period) throw new HttpError(422, "invoice-period-required");
    const invoice = closePartnerInvoicePeriod(store, partner, body.period);
    sendJson(response, 200, { invoice: invoiceView(invoice) });
    return true;
  }

  return false;
}