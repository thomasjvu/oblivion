import type { IncomingMessage, ServerResponse } from "node:http";
import { handleIntegrationAgentRoutes } from "./integrations/agents.js";
import { handleIntegrationOneShotRoutes } from "./integrations/oneshot.js";
import { handleIntegrationStatusRoutes } from "./integrations/status.js";
import { handleIntegrationVeniceRoutes } from "./integrations/venice.js";
import { handleIntegrationWalletRoutes } from "./integrations/wallet.js";
import type { ConsumerContext } from "./context.js";

export async function handleConsumerIntegrationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  if (await handleIntegrationWalletRoutes(request, response, url, context)) return true;
  if (await handleIntegrationStatusRoutes(request, response, url, context)) return true;
  if (await handleIntegrationOneShotRoutes(request, response, url, context)) return true;
  if (await handleIntegrationAgentRoutes(request, response, url, context)) return true;
  if (await handleIntegrationVeniceRoutes(request, response, url, context)) return true;
  return false;
}