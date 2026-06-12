import type { IncomingMessage, ServerResponse } from "node:http";
import { docsUrl } from "../../docsRedirect.js";
import { handleAgentRun } from "../../handlers/agentRun.js";
import { meterVeniceAnalysis, meterVeniceChat } from "../../handlers/veniceMeter.js";
import { buildAttestationProof } from "../../../domain/attestation.js";
import {
  createAgentDelegationSet,
  createEip7702Authorization,
  createErc7715Permission,
  createTimelineEvent,
  pendingHackathonTracks,
  resolveSmartAccountAddress
} from "../../../domain/hackathon.js";
import { buildAgentNextStep, buildHackathonStatusForCase } from "../../../domain/orchestration.js";
import { redactText } from "../../../domain/redaction.js";
import {
  isBraveSearchConfigured,
  isVeniceSearchConfigured,
  isHibpConfigured,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isOneShotLiveReady,
  isX402Configured,
  oneShotWebhookDestinationUrl
} from "../../../domain/integrations.js";
import { isVeniceConfigured } from "../../../domain/venice.js";
import { isBrokerEmailConfigured } from "../../../domain/brokerMailer.js";
import { callOneShotRpc, relayOneShotForCase } from "../../../domain/oneshot.js";
import { relayerEventFromOneShotWebhook, type OneShotWebhookPayload } from "../../../domain/oneshotWebhook.js";
import { deploymentEnvironment, deploymentProfile, walletChainConfig } from "../../../domain/deploymentEnv.js";
import { partnerPresetAllowlist } from "../../../domain/partners.js";
import { assertCaseActivated } from "../../../domain/caseActivation.js";
import { getCaseWithAccess } from "../../auth.js";
import { HttpError } from "../../errors.js";
import { readJson, sendJson } from "../../http.js";
import {
  type AgentDelegateBody,
  type AgentMessageBody,
  type AgentRunBody,
  type ConsumerContext,
  type RelayerBody,
  type SmartAccountBody,
  type VeniceBody,
  parseAgentName
} from "./context.js";

export async function handleConsumerIntegrationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store, trustCenterPath, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/integrations/wallet-config") {
    const chain = walletChainConfig();
    const liveEnabled = process.env.WALLET_LIVE_MODE === "true";
    const profile = deploymentProfile();
    sendJson(response, 200, {
      mode: liveEnabled ? "live" : "demo",
      liveEnabled,
      environment: deploymentEnvironment(),
      environmentLabel: profile.label,
      chainId: chain.chainId,
      chainIdHex: chain.chainIdHex,
      addChainParams: chain.addChainParams,
      poll: { attempts: 12, delayMs: 1500 }
    });
    return true;
  }

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
        metamaskSmartAccounts: process.env.WALLET_LIVE_MODE === "true",
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

  if (method === "POST" && url.pathname === "/api/metamask/smart-account-session") {
    const body = await readJson<SmartAccountBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.walletAddress || !body.walletAddress.startsWith("0x")) {
      throw new HttpError(422, "wallet-address-required");
    }
    if (process.env.WALLET_LIVE_MODE !== "true") {
      throw new HttpError(503, "smart-account-live-required");
    }
    const smartAccountAddress = resolveSmartAccountAddress({
      walletAddress: body.walletAddress,
      smartAccountAddress: body.smartAccountAddress
    });
    const eip7702 = createEip7702Authorization(caseRecord.id, body.walletAddress, smartAccountAddress);
    const erc7715 = createErc7715Permission(caseRecord.id);
    store.permissionGrants.set(eip7702.id, eip7702);
    store.permissionGrants.set(erc7715.id, erc7715);
    const smartDetail = `EIP-7702 authorization recorded after MetaMask batch${body.txHash ? ` (${body.txHash.slice(0, 10)}…)` : ""}.`;
    const timeline = [
      createTimelineEvent(caseRecord.id, "MetaMask", "Smart Account session", smartDetail),
      createTimelineEvent(
        caseRecord.id,
        "MetaMask",
        "ERC-7715 permission",
        "Advanced permission grants only task proposal, approval request, and narrow redelegation."
      )
    ];
    timeline.forEach((event) => store.agentTimeline.set(event.id, event));
    sendJson(response, 201, {
      mode: "live",
      walletAddress: redactText(body.walletAddress),
      smartAccountAddress,
      txHash: body.txHash,
      callsId: body.callsId,
      chainId: body.chainId,
      permissions: [eip7702, erc7715],
      timeline
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/1shot/webhook-url") {
    const caseId = url.searchParams.get("caseId");
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, {
      destinationUrl: oneShotWebhookDestinationUrl(caseId, sessionId)
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/rpc") {
    if (!isOneShotConfigured()) {
      throw new HttpError(503, "oneshot-not-configured");
    }
    const body = await readJson<{ method: string; params?: unknown }>(request);
    if (!body.method) throw new HttpError(422, "oneshot-method-required");
    const result = await callOneShotRpc(body.method, body.params);
    sendJson(response, 200, { result });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/relay") {
    if (!isOneShotConfigured()) {
      throw new HttpError(503, "oneshot-not-configured", {
        message: "Set ONESHOT_BASE_URL (default public relayer) and optional ONESHOT_API_KEY / ONESHOT_AUTHORIZATION."
      });
    }
    const body = await readJson<RelayerBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const relay = await relayOneShotForCase(body);
    relay.events.forEach((event) => store.relayerEvents.set(event.id, event));
    if (relay.taskId && body.sessionId) {
      const session = store.paymentSessions.get(body.sessionId);
      if (session && session.caseId === caseRecord.id) {
        store.paymentSessions.set(session.id, {
          ...session,
          relayerTaskId: relay.taskId,
          updatedAt: new Date().toISOString()
        });
      }
    }
    const timeline = createTimelineEvent(
      caseRecord.id,
      "1Shot",
      "Relayer status",
      `1Shot relay: ${relay.events.at(-1)?.status ?? "submitted"}`
    );
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 201, { events: relay.events, taskId: relay.taskId, timeline });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/1shot/webhook") {
    const caseId = url.searchParams.get("caseId");
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (!caseId) throw new HttpError(422, "case-id-required");
    const caseRecord = getCaseWithAccess(request, store, caseId);
    const body = await readJson<OneShotWebhookPayload>(request);
    const event = relayerEventFromOneShotWebhook({
      caseId: caseRecord.id,
      sessionId,
      payload: body
    });
    store.relayerEvents.set(event.id, event);
    if (event.taskId && sessionId) {
      const session = store.paymentSessions.get(sessionId);
      if (session && session.caseId === caseRecord.id) {
        store.paymentSessions.set(session.id, {
          ...session,
          relayerTaskId: event.taskId,
          updatedAt: new Date().toISOString()
        });
      }
    }
    const timeline = createTimelineEvent(caseRecord.id, "1Shot", "Webhook status", event.message);
    store.agentTimeline.set(timeline.id, timeline);
    sendJson(response, 202, { event, timeline });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/agent/next") {
    const caseId = url.searchParams.get("caseId");
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, buildAgentNextStep(store, caseId));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agent/chat") {
    const body = await readJson<{ caseId: string; message: string; walletAddress?: string }>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.message?.trim()) throw new HttpError(422, "agent-message-required");
    const result = await meterVeniceChat(store, caseRecord, {
      message: body.message,
      walletAddress: body.walletAddress
    });
    sendJson(response, 200, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agent/run-next") {
    const body = await readJson<AgentRunBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    assertCaseActivated(store, caseRecord);
    const result = await handleAgentRun(store, caseRecord, trustCenterPath);
    sendJson(response, 200, result);
    return true;
  }

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

  if (method === "POST" && url.pathname === "/api/agents/delegate") {
    const body = await readJson<AgentDelegateBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const result = createAgentDelegationSet(caseRecord.id);
    result.grants.forEach((grant) => store.permissionGrants.set(grant.id, grant));
    result.delegations.forEach((delegation) => store.agentDelegations.set(delegation.id, delegation));
    result.messages.forEach((message) => store.agentMessages.set(message.id, message));
    result.timeline.forEach((event) => store.agentTimeline.set(event.id, event));
    sendJson(response, 201, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agents/message") {
    const body = await readJson<AgentMessageBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.purpose) throw new HttpError(422, "message-purpose-required");
    const fromAgent = parseAgentName(body.fromAgent ?? "OblivionRoot");
    const toAgent = parseAgentName(body.toAgent ?? "VerifierAgent");
    const message = {
      id: `agent_msg_${crypto.randomUUID()}`,
      caseId: caseRecord.id,
      fromAgent,
      toAgent,
      purpose: redactText(body.purpose),
      redactedPayload: redactText(body.payload ?? ""),
      createdAt: new Date().toISOString()
    };
    store.agentMessages.set(message.id, message);
    sendJson(response, 201, { message });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/agents/timeline") {
    const caseId = url.searchParams.get("caseId");
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, {
      permissions: store.permissionGrantsForCase(caseId),
      payments: store.paymentSessionsForCase(caseId),
      relayerEvents: store.relayerEventsForCase(caseId),
      veniceAnalyses: store.veniceAnalysesForCase(caseId),
      delegations: store.agentDelegationsForCase(caseId),
      messages: store.agentMessagesForCase(caseId),
      timeline: store.agentTimelineForCase(caseId)
    });
    return true;
  }

  if (process.env.HACKATHON_MODE === "true") {
    if (method === "GET" && url.pathname === "/api/hackathon/status") {
      const caseId = url.searchParams.get("caseId");
      if (!caseId) throw new HttpError(422, "case-id-required");
      getCaseWithAccess(request, store, caseId);
      const walletAddress = url.searchParams.get("walletAddress") ?? undefined;
      const status = buildHackathonStatusForCase(store, caseId, walletAddress);
      sendJson(response, 200, {
        status,
        pending: pendingHackathonTracks(status)
      });
      return true;
    }
  }

  return false;
}