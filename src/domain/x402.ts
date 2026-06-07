import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorConfig,
  type HTTPAdapter,
  type HTTPProcessResult,
  type RoutesConfig
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isX402Configured, x402FacilitatorUrl, x402Network, x402PayTo } from "./integrations.js";
import type { PaymentProduct, PaymentSession } from "./types.js";
import { productForMode } from "./hackathon.js";

let httpResourceServer: x402HTTPResourceServer | null = null;
let initPromise: Promise<void> | null = null;

function priceForProduct(product: PaymentProduct): string {
  return `$${product.amountUsd.toFixed(product.amountUsd >= 1 ? 2 : 3)}`;
}

function buildRoutes(): RoutesConfig {
  const payTo = x402PayTo() as `0x${string}`;
  const network = x402Network() as Network;
  const routes: RoutesConfig = {};
  for (const product of ["broker-opt-out-packet", "weekly-monitor"] as const) {
    const item = productForMode(product === "weekly-monitor" ? "subscription" : "one-off", product);
    const path = item.x402Endpoint;
    routes[`POST ${path}`] = {
      accepts: [
        {
          scheme: "exact",
          price: priceForProduct(item),
          network,
          payTo
        }
      ],
      description: item.description,
      mimeType: "application/json",
      resource: path
    };
  }
  return routes;
}

async function ensureX402Server(): Promise<x402HTTPResourceServer> {
  if (httpResourceServer) return httpResourceServer;
  if (!initPromise) {
    initPromise = (async () => {
      const facilitatorClient = new HTTPFacilitatorClient({
        url: x402FacilitatorUrl(),
        createAuthHeaders: cdpAuthHeaders()
      });
      const resourceServer = new x402ResourceServer(facilitatorClient).register(
        x402Network() as Network,
        new ExactEvmScheme()
      );
      httpResourceServer = new x402HTTPResourceServer(resourceServer, buildRoutes());
      await httpResourceServer.initialize();
    })();
  }
  await initPromise;
  return httpResourceServer!;
}

function cdpAuthHeaders(): FacilitatorConfig["createAuthHeaders"] {
  const keyId = process.env.X402_CDP_API_KEY_ID?.trim();
  const secret = process.env.X402_CDP_API_KEY_SECRET?.trim();
  if (!keyId || !secret) return undefined;
  return async () => {
    const token = Buffer.from(`${keyId}:${secret}`).toString("base64");
    const authorization = `Basic ${token}`;
    return {
      verify: { authorization },
      settle: { authorization },
      supported: { authorization }
    };
  };
}

export function createNodeHttpAdapter(request: IncomingMessage, url: URL): HTTPAdapter {
  return {
    getHeader(name: string) {
      const key = name.toLowerCase();
      const raw = request.headers[key];
      return Array.isArray(raw) ? raw[0] : raw;
    },
    getMethod() {
      return request.method ?? "GET";
    },
    getPath() {
      return url.pathname;
    },
    getUrl() {
      return url.pathname + url.search;
    },
    getAcceptHeader() {
      return this.getHeader("accept") ?? "";
    },
    getUserAgent() {
      return this.getHeader("user-agent") ?? "";
    }
  };
}

export async function processX402Request(input: {
  request: IncomingMessage;
  url: URL;
}): Promise<HTTPProcessResult | null> {
  if (!isX402Configured()) return null;
  const server = await ensureX402Server();
  return server.processHTTPRequest({
    adapter: createNodeHttpAdapter(input.request, input.url),
    path: input.url.pathname,
    method: input.request.method ?? "GET"
  });
}

export function applyX402HttpResult(response: ServerResponse, result: HTTPProcessResult): boolean {
  if (result.type === "no-payment-required") return false;
  if (result.type === "payment-error" && result.response) {
    const headers = { ...result.response.headers };
    response.writeHead(result.response.status, headers);
    const body = result.response.body;
    response.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return true;
  }
  return false;
}

export async function settleX402Payment(input: {
  request: IncomingMessage;
  url: URL;
  verified: Extract<HTTPProcessResult, { type: "payment-verified" }>;
}): Promise<{ ok: boolean; transaction?: string; error?: string }> {
  const server = await ensureX402Server();
  const settle = await server.processSettlement(
    input.verified.paymentPayload,
    input.verified.paymentRequirements,
    input.verified.declaredExtensions,
    {
      request: {
        adapter: createNodeHttpAdapter(input.request, input.url),
        path: input.url.pathname,
        method: input.request.method ?? "GET"
      }
    }
  );
  if (settle.success) {
    return { ok: true, transaction: settle.transaction };
  }
  return { ok: false, error: settle.errorMessage ?? settle.errorReason ?? "settlement-failed" };
}

export function x402PublicConfig() {
  const enabled = isX402Configured();
  return {
    enabled,
    protocolVersion: "x402-v2",
    facilitatorUrl: x402FacilitatorUrl(),
    network: x402Network(),
    payTo: enabled ? x402PayTo() : undefined,
    paymentHeader: "PAYMENT-SIGNATURE",
    requiredHeader: "PAYMENT-REQUIRED"
  };
}

export function markSessionPaid(session: PaymentSession, settlementTx?: string): PaymentSession {
  const now = new Date().toISOString();
  return {
    ...session,
    status: "paid",
    updatedAt: now,
    x402Request: {
      ...session.x402Request,
      version: "x402-v2",
      memo: settlementTx ? `${session.x402Request.memo} · settled ${settlementTx.slice(0, 10)}…` : session.x402Request.memo
    }
  };
}