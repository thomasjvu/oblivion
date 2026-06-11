import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { docsUrl } from "../docsRedirect.js";
import {
  handleAgentRunStep,
  handleApplyPreset,
  handleApprove,
  handleCaseDiscover,
  handleCaseIntake,
  handleExecute,
  handleFindingDecision,
  type IntakeBody
} from "../handlers/caseHandlers.js";
import { meterVeniceAnalysis, meterVeniceChat } from "../handlers/veniceMeter.js";
import { buildAttestationProof, type TrustCenterConfig } from "../../domain/attestation.js";
import { buildAgentPlanView, CLEANUP_PRESETS, presetUsesBrokerDiscovery, presetUsesContentDiscovery } from "../../domain/cleanup.js";
import {
  createAgentDelegationSet,
  createEip7702Authorization,
  createErc7715Permission,
  createPaymentPermission,
  createPaymentSession,
  createTimelineEvent,
  pendingHackathonTracks,
  resolveSmartAccountAddress,
  X402_PRODUCTS
} from "../../domain/hackathon.js";
import {
  buildAgentNextStep,
  buildHackathonStatusForCase,
  buildStatus,
  proposeApprovedAction
} from "../../domain/orchestration.js";
import { redactText } from "../../domain/redaction.js";
import { describeDiscoveryPlan, discoveryReadinessMessage } from "../../domain/exposureDiscovery.js";
import { isBrokerEmailConfigured } from "../../domain/brokerMailer.js";
import {
  isBraveSearchConfigured,
  isVeniceSearchConfigured,
  isHibpConfigured,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isOneShotLiveReady,
  isX402Configured,
  oblivionPublicApiUrl,
  oneShotWebhookDestinationUrl
} from "../../domain/integrations.js";
import { callOneShotRpc, relayOneShotForCase, type OneShotRelayBody } from "../../domain/oneshot.js";
import { relayerEventFromOneShotWebhook, type OneShotWebhookPayload } from "../../domain/oneshotWebhook.js";
import {
  applyX402HttpResult,
  markSessionPaid,
  processX402Request,
  settleX402Payment,
  x402PublicConfig
} from "../../domain/x402.js";
import {
  assertCreditsForDiscovery,
  creditRates,
  creditsBypassEnabled,
  debitCreditsForDiscovery,
  discoveryCredits,
  resolveCreditsView,
  settleCreditsForProduct,
  STARTER_PACK_CREDITS,
  MONITOR_MONTHLY_CREDITS
} from "../../domain/credits.js";
import { sanitizeForLog } from "../../domain/safeLogging.js";
import { isVeniceConfigured } from "../../domain/venice.js";
import type {
  ActionType,
  AgentName,
  AutonomyMode,
  AuthorityBasis,
  CaseRecord,
  IdentifierCategory,
  Jurisdiction,
  PaymentMode,
  PresetId,
  RiskLevel
} from "../../domain/types.js";
import {
  assertCaseActivated,
  autoActivateCaseForSubscriptionWallet,
  markCaseActivated
} from "../../domain/caseActivation.js";
import {
  assertPreviewQuota,
  previewDailyLimit,
  previewUsageRemaining,
  recordPreviewUsage,
  runDiscoveryPreview
} from "../../domain/discoveryPreview.js";
import { casesForWallet, linkCaseToWallet, walletAddressForCase } from "../../domain/walletCases.js";
import { clientIp } from "../clientIp.js";
import { createCaseRecord, publicCaseView } from "../../domain/cases.js";
import { deploymentEnvironment, deploymentProfile, walletChainConfig } from "../../domain/deploymentEnv.js";
import { purgeCaseData } from "../../domain/purgeCase.js";
import { partnerPresetAllowlist } from "../../domain/partners.js";
import { recordPartnerDataAccess } from "../../domain/partnerAudit.js";
import { emitCaseDeletedWebhook } from "../../domain/webhooks.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import { assertCaseExportAllowed, getCaseWithAccess, resolvePartnerAuth } from "../auth.js";
import { HttpError } from "../errors.js";
import { readJson, sendJson } from "../http.js";
import { emitApprovalPendingWebhook } from "./v1.js";
import { handleConnectorRoutes } from "./connectors.js";

export interface ConsumerContext {
  store: MemoryStore;
  trustCenterPath: string;
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>;
}

interface CreateCaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  retentionDays?: number;
  casePreferences?: {
    operatorEmailRelay?: boolean;
  };
}

interface ProposeActionBody {
  caseId: string;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  sourceVerified?: boolean;
  plaintextPreview?: string;
  expectedConfirmationStep?: string;
}

interface CaseBody {
  caseId: string;
}

interface SmartAccountBody {
  caseId: string;
  walletAddress: string;
  mode?: "demo" | "live";
  smartAccountAddress?: string;
  txHash?: string;
  callsId?: string;
  chainId?: number;
}

interface PaymentBody {
  caseId: string;
  productId?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

interface VeniceBody {
  caseId: string;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
}

interface AgentDelegateBody {
  caseId: string;
}

interface AgentMessageBody {
  caseId: string;
  fromAgent?: string;
  toAgent?: string;
  purpose: string;
  payload?: string;
}

interface RelayerBody extends OneShotRelayBody {}

interface CasePreferencesBody {
  operatorEmailRelay: boolean;
}

interface CreditsPurchaseBody {
  caseId: string;
  walletAddress: string;
  paymentSessionId?: string;
  smartAccountAddress?: string;
  productId?: string;
}

interface AgentRunBody {
  caseId: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

interface CaseAgentRunBody {
  highAutonomy?: boolean;
}

function parseAgentName(value: string): AgentName {
  const allowed: AgentName[] = [
    "OblivionRoot",
    "ScoutAgent",
    "DraftAgent",
    "VerifierAgent",
    "PaymentAgent",
    "SchedulerAgent"
  ];
  if (!allowed.includes(value as AgentName)) throw new HttpError(422, "unsupported-agent");
  return value as AgentName;
}

export async function handleConsumerApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store, trustCenterPath, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/skills") {
    sendJson(response, 200, {
      skills: [
        {
          id: "clean-online-identity",
          name: "Clean Online Identity",
          description:
            "Supervised personal data removal across brokers, search results, and privacy rights workflows.",
          repository: "thomasjvu/oblivion",
          skillPath: "skills/clean-online-identity",
          install: {
            npx: "npx skills add thomasjvu/oblivion --skill clean-online-identity",
            curl: "curl -fsSL {origin}/skill.sh | bash",
            skillMd: "/skills/clean-online-identity/SKILL.md",
            manifest: "/skills/clean-online-identity/manifest.json"
          }
        }
      ]
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/presets") {
    sendJson(response, 200, { presets: CLEANUP_PRESETS });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/cases") {
    throw new HttpError(401, "case-list-not-available");
  }

  if (method === "POST" && url.pathname === "/api/discovery/preview") {
    const body = await readJson<{
      personLabel?: string;
      aliases?: string[];
      regionLabel?: string;
      walletAddress?: string;
    }>(request);
    const ip = clientIp(request);
    assertPreviewQuota(store, ip, body.walletAddress);
    const preview = await runDiscoveryPreview({
      personLabel: body.personLabel || "",
      aliases: body.aliases,
      regionLabel: body.regionLabel
    });
    const remainingPreviews = recordPreviewUsage(store, ip, body.walletAddress);
    sendJson(response, 200, {
      candidates: preview.candidates,
      stats: preview.stats,
      remainingPreviews,
      dailyLimit: previewDailyLimit()
    });
    return true;
  }

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

  if (method === "POST" && url.pathname === "/api/cases") {
    const body = await readJson<CreateCaseBody>(request);
    const { caseRecord, accessToken } = createCaseRecord(body);
    store.cases.set(caseRecord.id, caseRecord);
    sendJson(response, 201, {
      case: publicCaseView(caseRecord),
      accessToken,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const caseReadMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (method === "GET" && caseReadMatch) {
    const caseRecord = getCaseWithAccess(request, store, caseReadMatch[1]);
    sendJson(response, 200, {
      case: publicCaseView(caseRecord),
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const presetMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/preset$/);
  if (method === "POST" && presetMatch) {
    const body = await readJson<{ presetId: PresetId; autonomyMode?: AutonomyMode; walletAddress?: string }>(
      request
    );
    let caseRecord = getCaseWithAccess(request, store, presetMatch[1]);
    if (body.walletAddress?.startsWith("0x")) {
      const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
      if (activated) caseRecord = activated;
    }
    assertCaseActivated(store, caseRecord);
    const { preset, plan, timeline } = await handleApplyPreset(store, caseRecord, body);
    sendJson(response, 201, {
      preset,
      plan,
      timeline,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const planMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/plan$/);
  if (method === "GET" && planMatch) {
    const caseRecord = getCaseWithAccess(request, store, planMatch[1]);
    const plan = store.agentPlanForCase(caseRecord.id);
    sendJson(response, 200, {
      plan: plan ? buildAgentPlanView(plan) : null,
      presets: CLEANUP_PRESETS,
      connectorResults: store.connectorResultsForCase(caseRecord.id),
      timeline: store.agentTimelineForCase(caseRecord.id)
    });
    return true;
  }

  const caseAgentRunMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/agent\/run$/);
  if (method === "POST" && caseAgentRunMatch) {
    const body = await readJson<CaseAgentRunBody>(request);
    const caseRecord = getCaseWithAccess(request, store, caseAgentRunMatch[1]);
    assertCaseActivated(store, caseRecord);
    const result = await handleAgentRunStep(store, caseRecord, trustCenterPath, {
      highAutonomy: body.highAutonomy
    });
    sendJson(response, 200, result);
    return true;
  }

  const intakeMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/intake$/);
  if (method === "POST" && intakeMatch) {
    const body = await readJson<IntakeBody>(request);
    const caseRecord = getCaseWithAccess(request, store, intakeMatch[1]);
    handleCaseIntake(store, caseRecord, body);
    sendJson(response, 200, {
      case: publicCaseView(caseRecord),
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const findingsListMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings$/);
  if (method === "GET" && findingsListMatch) {
    const caseRecord = getCaseWithAccess(request, store, findingsListMatch[1]);
    const status = buildStatus(store, caseRecord.id);
    const plan = store.agentPlanForCase(caseRecord.id);
    const presetId = plan?.presetId;
    sendJson(response, 200, {
      findings: status.findings,
      pendingFindings: status.pendingFindings,
      confirmedFindings: status.confirmedFindings,
      discovery: discoveryReadinessMessage(),
      discoveryPlan: describeDiscoveryPlan({
        scope: caseRecord.redactedScope,
        pastedUrlCount: 0,
        brokerSweep: presetId ? presetUsesBrokerDiscovery(presetId) : true,
        contentTakedown: presetId ? presetUsesContentDiscovery(presetId) : false
      })
    });
    return true;
  }

  const findingsDiscoverMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/discover$/);
  if (method === "POST" && findingsDiscoverMatch) {
    let caseRecord = getCaseWithAccess(request, store, findingsDiscoverMatch[1]);
    const body = await readJson<{ pastedUrls?: string[]; walletAddress?: string }>(request);
    if (body.walletAddress?.startsWith("0x")) {
      const activated = autoActivateCaseForSubscriptionWallet(store, caseRecord, body.walletAddress);
      if (activated) caseRecord = activated;
    }
    assertCaseActivated(store, caseRecord);
    const walletAddress =
      body.walletAddress?.startsWith("0x") ? body.walletAddress : walletAddressForCase(store, caseRecord.id);
    if (!walletAddress && !creditsBypassEnabled()) {
      throw new HttpError(422, "wallet-address-required");
    }
    if (walletAddress) assertCreditsForDiscovery(store, walletAddress);
    const plan = store.agentPlanForCase(caseRecord.id);
    const presetId = plan?.presetId;
    const brokerSweep = presetId ? presetUsesBrokerDiscovery(presetId) : true;
    try {
      const { discovered, discovery, discoveryPlan } = await handleCaseDiscover(store, caseRecord, body, presetId);
      if (walletAddress && brokerSweep) {
        debitCreditsForDiscovery(store, walletAddress, caseRecord.id);
      }
      const timeline = createTimelineEvent(
        caseRecord.id,
        "ScoutAgent",
        "Discovery run",
        discovered.length
          ? `${discovered.length} candidate link(s) added for review.`
          : "No new candidates. Paste URLs or configure Brave search."
      );
      store.agentTimeline.set(timeline.id, timeline);
      sendJson(response, 201, {
        discovered,
        status: buildStatus(store, caseRecord.id),
        timeline,
        discovery,
        discoveryPlan,
        credits: walletAddress ? resolveCreditsView(store, walletAddress) : undefined,
        discoveryCreditsDebited: walletAddress && brokerSweep ? discoveryCredits() : 0
      });
    } catch (error) {
      throw new HttpError(502, "discovery-failed", {
        message: discoveryReadinessMessage(),
        detail: sanitizeForLog(error)
      });
    }
    return true;
  }

  const findingConfirmMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/([^/]+)\/(confirm|reject)$/);
  if (method === "POST" && findingConfirmMatch) {
    const caseRecord = getCaseWithAccess(request, store, findingConfirmMatch[1]);
    assertCaseActivated(store, caseRecord);
    const decision = findingConfirmMatch[3] === "confirm" ? "confirmed" : "rejected";
    const { exposure, timeline, status } = handleFindingDecision(
      store,
      caseRecord,
      findingConfirmMatch[2],
      decision
    );
    sendJson(response, 200, { exposure, status, timeline });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/actions/propose") {
    const body = await readJson<ProposeActionBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    assertCaseActivated(store, caseRecord);
    const { approval, action } = proposeApprovedAction({
      store,
      caseRecord,
      body: {
        ...body,
        identifiers: body.identifiers ?? [],
        dataToDisclose: body.dataToDisclose ?? []
      }
    });
    await emitApprovalPendingWebhook(store, caseRecord.id, approval);
    sendJson(response, 201, {
      policy: { allowed: true, reasons: [] },
      approval,
      action,
      status: buildStatus(store, caseRecord.id)
    });
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const body = await readJson<{ userConfirmation: string }>(request);
    const pendingApproval = store.approvals.get(approveMatch[1]);
    if (!pendingApproval) throw new HttpError(404, "approval-not-found");
    const approvalCase = getCaseWithAccess(request, store, pendingApproval.caseId);
    assertCaseActivated(store, approvalCase);
    const { approval, caseId } = await handleApprove(store, approveMatch[1], body);
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, { approval, status: buildStatus(store, caseId) });
    return true;
  }

  const executeMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const body = await readJson<{ hashPrefix?: string; emailLabel?: string; sourceUrl?: string; walletAddress?: string }>(request);
    const pendingAction = store.actions.get(executeMatch[1]);
    if (!pendingAction) throw new HttpError(404, "action-not-found");
    const executeCase = getCaseWithAccess(request, store, pendingAction.caseId);
    assertCaseActivated(store, executeCase);
    const { action, approval, executed, caseRecord } = await handleExecute(
      store,
      executeMatch[1],
      body,
      loadTrustCenterConfig
    );
    getCaseWithAccess(request, store, caseRecord.id);
    sendJson(response, 200, {
      action,
      approval,
      executorMode: executed.mode,
      connectorResult: executed.connectorResult,
      status: buildStatus(store, action.caseId)
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/trust/attestation") {
    const config = await loadTrustCenterConfig();
    const fetchLive = url.searchParams.get("live") !== "0";
    sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/trust/privacy") {
    sendJson(response, 200, {
      storedPlaintext: false,
      serverCanDecryptCaseVault: false,
      rawPiiToNonTeeLlm: false,
      defaultExecutor: "record-only",
      sensitiveActionRequiresApproval: true,
      thirdPartyDisclosureStillPossible: true,
      message:
        "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties, and sensitive plaintext should only be decrypted in the browser or an attested TEE task."
    });
    return true;
  }

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

  if (method === "GET" && url.pathname === "/api/credits/catalog") {
    sendJson(response, 200, {
      products: X402_PRODUCTS,
      rates: creditRates(),
      config: x402PublicConfig()
    });
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

  if (method === "GET" && url.pathname === "/api/x402/config") {
    sendJson(response, 200, x402PublicConfig());
    return true;
  }

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

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      apiOrigin: oblivionPublicApiUrl() || null,
      corsOrigin: process.env.OBLIVION_CORS_ORIGIN?.trim() || null
    });
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

  if (
    method === "POST" &&
    (url.pathname === "/api/credits/purchase" ||
      url.pathname === "/api/credits/monitor" ||
      url.pathname === "/api/agent/premium-task" ||
      url.pathname === "/api/agent/monitor")
  ) {
    const body = await readJson<CreditsPurchaseBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.walletAddress?.startsWith("0x")) throw new HttpError(422, "wallet-address-required");
    const expectedMode: PaymentMode =
      url.pathname.endsWith("monitor") || url.pathname.endsWith("/monitor") ? "subscription" : "one-off";
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
    const result = await handleAgentRunStep(store, caseRecord, trustCenterPath);
    sendJson(response, 200, result);
    return true;
  }

  if (await handleConnectorRoutes({
    request,
    response,
    method,
    url,
    store,
    trustCenterConfig: loadTrustCenterConfig
  })) {
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
    sendJson(response, 200, {
      exportedAt: new Date().toISOString(),
      case: publicCaseView(caseRecord),
      approvals: store.approvalsForCase(caseRecord.id),
      actions: store.actionsForCase(caseRecord.id),
      exposures: store.exposuresForCase(caseRecord.id),
      sourceChecks: [...store.sourceChecks.values()].filter((sourceCheck) => sourceCheck.caseId === caseRecord.id),
      followUps: store.followUpsForCase(caseRecord.id),
      paymentSessions: store.paymentSessionsForCase(caseRecord.id),
      permissionGrants: store.permissionGrantsForCase(caseRecord.id),
      relayerEvents: store.relayerEventsForCase(caseRecord.id),
      veniceAnalyses: store.veniceAnalysesForCase(caseRecord.id),
      agentDelegations: store.agentDelegationsForCase(caseRecord.id),
      agentMessages: store.agentMessagesForCase(caseRecord.id),
      agentTimeline: store.agentTimelineForCase(caseRecord.id),
      agentPlan: store.agentPlanForCase(caseRecord.id) ?? null,
      connectorResults: store.connectorResultsForCase(caseRecord.id)
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/delete") {
    const body = await readJson<CaseBody>(request);
    const caseRecord = store.getCaseOrThrow(body.caseId);
    assertCaseExportAllowed(request, store, caseRecord);
    if (caseRecord.partnerId) {
      const partner = resolvePartnerAuth(request, store);
      if (partner) {
        recordPartnerDataAccess(store, {
          partnerId: partner.id,
          caseId: caseRecord.id,
          action: "delete",
          source: "api"
        });
      }
      await emitCaseDeletedWebhook(store, caseRecord.id);
    }
    const deletedAt = new Date().toISOString();
    caseRecord.deletedAt = deletedAt;
    caseRecord.encryptedIntake = undefined;
    caseRecord.encryptedVaultPointer = "deleted";
    purgeCaseData(store, caseRecord.id);
    store.tombstones.set(caseRecord.id, deletedAt);
    sendJson(response, 200, { caseId: caseRecord.id, deletedAt, tombstone: true });
    return true;
  }

  return false;
}

export async function loadTrustCenterConfigFromPath(trustCenterPath: string): Promise<TrustCenterConfig> {
  const config = JSON.parse(await readFile(trustCenterPath, "utf8")) as TrustCenterConfig;
  return {
    ...config,
    attestationReportUrl: process.env.PHALA_ATTESTATION_URL ?? config.attestationReportUrl ?? null,
    phalaVerifierEndpoint: process.env.PHALA_VERIFIER_ENDPOINT ?? config.phalaVerifierEndpoint ?? null,
    maxAttestationAgeSeconds: Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? config.maxAttestationAgeSeconds ?? 600)
  };
}