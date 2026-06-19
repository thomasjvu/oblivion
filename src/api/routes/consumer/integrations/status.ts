import type { IncomingMessage, ServerResponse } from "node:http";
import { docsUrl } from "../../../docsRedirect.js";
import { buildAttestationProof } from "../../../../domain/attestation.js";
import {
  isBraveSearchConfigured,
  isVeniceSearchConfigured,
  isHibpConfigured,
  isLiveExecutorEnabled,
  isOneShotLiveReady,
  isX402Configured,
  walletLiveMode
} from "../../../../domain/integrations.js";
import { isVeniceConfigured } from "../../../../domain/venice.js";
import { isBrokerEmailConfigured } from "../../../../domain/brokerMailer.js";
import { deploymentEnvironment, deploymentProfile } from "../../../../domain/deploymentEnv.js";
import { partnerPresetAllowlist } from "../../../../domain/partners.js";
import { sendJson } from "../../../http.js";
import type { ConsumerContext } from "../context.js";

export async function handleIntegrationStatusRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/integrations/status") {
    const trustConfig = await loadTrustCenterConfig();
    const attestationProof = await buildAttestationProof(trustConfig, { fetchLive: true });
    const deployProfile = deploymentProfile();
    sendJson(response, 200, {
      deploymentEnvironment: deploymentEnvironment(),
      deploymentLabel: deployProfile.label,
      x402Network: deployProfile.x402Network,
      hackathonMode: process.env.HACKATHON_MODE === "true",
      mode: isVeniceConfigured() ? "live-agent" : "wallet-and-policy",
      executorMode: isLiveExecutorEnabled() ? "live" : "record-only",
      liveReady: {
        metamaskSmartAccounts: walletLiveMode(),
        x402: isX402Configured(),
        erc7710: isX402Configured(),
        venice: isVeniceConfigured(),
        oneShot: isOneShotLiveReady(),
        brokerWebForm: process.env.BROKER_WEBFORM_AUTOMATION === "true",
        hibpEmail: isHibpConfigured(),
        veniceSearch: isVeniceSearchConfigured(),
        braveSearch: isBraveSearchConfigured(),
        brokerEmail: isBrokerEmailConfigured(),
        platformAbuseEmail: isBrokerEmailConfigured(),
        liveExecutor: isLiveExecutorEnabled(),
        phalaAttestation: attestationProof.verifierResult === "pass"
      },
      partnerApi: {
        enabled: store.partners.size > 0,
        partnersConfigured: store.partners.size,
        productionPartners: [...store.partners.values()].filter((partner) => partner.environment === "production").length,
        sandboxPartners: [...store.partners.values()].filter((partner) => partner.environment === "sandbox").length,
        version: "v1",
        docs: docsUrl("/docs/developers/partner-api"),
        onboarding: docsUrl("/docs/developers/partner-onboarding"),
        openapi: "/docs/openapi-v1.yaml",
        presets: [...partnerPresetAllowlist()]
      },
      privacyInvariant:
        "Live adapters must stay behind the same approval, redaction, logging, and attestation gates."
    });
    return true;
  }

  return false;
}