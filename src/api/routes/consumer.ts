import type { IncomingMessage, ServerResponse } from "node:http";
import { handleConnectorRoutes } from "./connectors.js";
import { handleConsumerCaseRoutes } from "./consumer/cases.js";
import { type ConsumerContext } from "./consumer/context.js";
import { handleConsumerExportRoutes } from "./consumer/export.js";
import { handleConsumerIntegrationRoutes } from "./consumer/integrations.js";
import { handleConsumerMetaRoutes } from "./consumer/meta.js";
import { handleConsumerPaymentRoutes } from "./consumer/payments.js";
import { handleConsumerTrustRoutes } from "./consumer/trust.js";
import { handleConsumerWalletRoutes } from "./consumer/wallet.js";

export type { ConsumerContext } from "./consumer/context.js";

const routeHandlers = [
  handleConsumerMetaRoutes,
  handleConsumerCaseRoutes,
  handleConsumerWalletRoutes,
  handleConsumerPaymentRoutes,
  handleConsumerIntegrationRoutes,
  handleConsumerTrustRoutes,
  handleConsumerExportRoutes
] as const;

export async function handleConsumerApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const method = request.method ?? "GET";

  for (const handler of routeHandlers) {
    if (await handler(request, response, url, context)) {
      return true;
    }
  }

  if (
    await handleConnectorRoutes({
      request,
      response,
      method,
      url,
      store: context.store,
      trustCenterConfig: context.loadTrustCenterConfig
    })
  ) {
    return true;
  }

  return false;
}