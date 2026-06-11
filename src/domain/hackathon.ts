import { followUpDate } from "./deadlines.js";
import { walletHasCreditsOrPayment, walletKeyFromAddress } from "./credits.js";
import { isX402Configured, x402Network } from "./integrations.js";
import { redactText } from "./redaction.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type {
  AgentDelegation,
  AgentMessage,
  AgentName,
  AgentTimelineEvent,
  Erc7710Delegation,
  HackathonStatus,
  IdentifierCategory,
  PaymentMode,
  PaymentProduct,
  PaymentSession,
  PermissionGrant,
  RelayerEvent,
  RelayerStatus,
  VeniceAnalysis,
  X402PaymentRequest
} from "./types.js";

export const X402_PRODUCTS: PaymentProduct[] = [
  {
    id: "credit-starter",
    name: "Starter credits",
    mode: "one-off",
    description: "$5 USDC for 500 wallet credits (~50k Venice tokens at default rates).",
    amountUsd: 5,
    token: "USDC",
    network: "base",
    x402Endpoint: "/api/credits/purchase",
    requiredPermission: "erc7710-payment"
  },
  {
    id: "credit-monitor",
    name: "Monitor subscription",
    mode: "subscription",
    description: "$10 USDC/month for 1,200 wallet credits refilled monthly.",
    amountUsd: 10,
    token: "USDC",
    network: "base",
    cadence: "monthly",
    x402Endpoint: "/api/credits/monitor",
    requiredPermission: "erc7710-payment"
  }
];

export function productForMode(mode: PaymentMode, productId?: string): PaymentProduct {
  const product = X402_PRODUCTS.find((item) => item.mode === mode && (!productId || item.id === productId));
  if (!product) throw Object.assign(new Error("payment-product-not-found"), { statusCode: 404 });
  return product;
}

export function resolveSmartAccountAddress(input: {
  walletAddress: string;
  smartAccountAddress?: string;
}): string {
  if (input.smartAccountAddress?.startsWith("0x") && input.smartAccountAddress.length === 42) {
    return input.smartAccountAddress;
  }
  if (process.env.WALLET_LIVE_MODE === "true" && input.walletAddress.startsWith("0x") && input.walletAddress.length === 42) {
    return input.walletAddress;
  }
  throw Object.assign(new Error("smart-account-address-required"), { statusCode: 422 });
}

export function createEip7702Authorization(
  caseId: string,
  walletAddress: string,
  smartAccountAddress?: string
): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "eip7702-authorization",
    delegate: smartAccountAddress ?? walletAddress,
    scope: ["upgrade-wallet-to-smart-account", "display-smart-account-session"],
    expiresAt: followUpDate(30),
    redelegatable: false,
    status: "granted"
  });
}

export function createErc7715Permission(caseId: string, delegate = "OblivionRoot"): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "erc7715-advanced",
    delegate,
    scope: [
      "propose-redacted-cleanup-tasks",
      "request-per-action-approval",
      "redelegate-minimum-agent-capabilities"
    ],
    expiresAt: followUpDate(14),
    redelegatable: true,
    status: "granted"
  });
}

export function createPaymentSession(input: {
  caseId: string;
  mode: PaymentMode;
  productId?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}): PaymentSession {
  const product = productForMode(input.mode, input.productId);
  const expiresAt = followUpDate(product.mode === "subscription" ? 30 : 1);
  if (!isX402Configured()) {
    throw Object.assign(new Error("x402-not-configured"), {
      statusCode: 503,
      message: "Set X402_PAY_TO and X402_FACILITATOR_URL for payment sessions."
    });
  }
  if (!input.walletAddress?.startsWith("0x")) {
    throw Object.assign(new Error("wallet-address-required"), { statusCode: 422 });
  }
  const walletKey = walletKeyFromAddress(input.walletAddress);
  const x402Request: X402PaymentRequest = {
    version: "x402-v2",
    endpoint: product.x402Endpoint,
    amountUsd: product.amountUsd,
    token: product.token,
    network: x402Network(),
    memo: `${product.name} for wallet credits`,
    expiresAt
  };
  const erc7710Delegation: Erc7710Delegation = {
    standard: "ERC-7710",
    delegate: "PaymentAgent",
    endpoint: product.x402Endpoint,
    spendCapUsd: product.mode === "subscription" ? product.amountUsd : product.amountUsd,
    token: product.token,
    cadence: product.cadence,
    expiresAt,
    scope: [
      product.mode === "subscription" ? "refill-monthly-credits" : "top-up-credits",
      "x402-only",
      "wallet-bound"
    ]
  };
  validateErc7710Delegation(erc7710Delegation);
  const now = new Date().toISOString();
  return {
    id: `payment_${crypto.randomUUID()}`,
    caseId: input.caseId,
    productId: product.id,
    mode: product.mode,
    status: "payment-required",
    amountUsd: product.amountUsd,
    token: product.token,
    network: product.network,
    cadence: product.cadence,
    x402Request,
    erc7710Delegation,
    walletKey,
    walletAddress: input.walletAddress,
    smartAccountAddress: input.smartAccountAddress,
    createdAt: now,
    updatedAt: now
  };
}

export function createPaymentPermission(caseId: string, session: PaymentSession): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "erc7710-payment",
    delegate: "PaymentAgent",
    scope: session.erc7710Delegation.scope,
    spendCapUsd: session.erc7710Delegation.spendCapUsd,
    token: session.erc7710Delegation.token,
    expiresAt: session.erc7710Delegation.expiresAt,
    redelegatable: false,
    status: "granted"
  });
}

export function validateErc7710Delegation(delegation: Erc7710Delegation): void {
  if (!delegation.expiresAt || Number.isNaN(Date.parse(delegation.expiresAt))) {
    throw Object.assign(new Error("erc7710-expiration-required"), { statusCode: 422 });
  }
  if (new Date(delegation.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error("erc7710-expired"), { statusCode: 422 });
  }
  if (!Number.isFinite(delegation.spendCapUsd) || delegation.spendCapUsd <= 0 || delegation.spendCapUsd > 100) {
    throw Object.assign(new Error("erc7710-spend-cap-invalid"), { statusCode: 422 });
  }
  if (containsBroadScope(delegation.scope)) {
    throw Object.assign(new Error("erc7710-scope-too-broad"), { statusCode: 422 });
  }
}

export function validatePermissionGrant(grant: PermissionGrant): void {
  if (!grant.expiresAt || new Date(grant.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error("permission-expiration-required"), { statusCode: 422 });
  }
  if (containsBroadScope(grant.scope)) {
    throw Object.assign(new Error("permission-scope-too-broad"), { statusCode: 422 });
  }
  if (grant.permissionType === "erc7710-payment" && (!grant.spendCapUsd || grant.spendCapUsd <= 0)) {
    throw Object.assign(new Error("payment-permission-spend-cap-required"), { statusCode: 422 });
  }
}

export function createAgentDelegationSet(caseId: string): {
  grants: PermissionGrant[];
  delegations: AgentDelegation[];
  messages: AgentMessage[];
  timeline: AgentTimelineEvent[];
} {
  const now = new Date();
  const expiresAt = followUpDate(7, now);
  const agents: Array<{
    toAgent: Exclude<AgentName, "OblivionRoot">;
    scope: string[];
    dataCategories: IdentifierCategory[];
    purpose: string;
  }> = [
    {
      toAgent: "ScoutAgent",
      scope: ["search-approved-public-sources", "record-candidate-exposure-url"],
      dataCategories: ["email", "city-state"],
      purpose: "Find candidate exposure pages from approved sources only."
    },
    {
      toAgent: "DraftAgent",
      scope: ["draft-removal-request", "use-redacted-template-context"],
      dataCategories: ["email"],
      purpose: "Draft user-reviewed removal text without submitting it."
    },
    {
      toAgent: "VerifierAgent",
      scope: ["verify-official-url", "check-attestation-status", "calculate-follow-up-window"],
      dataCategories: [],
      purpose: "Verify source paths, trust status, and follow-up deadlines."
    },
    {
      toAgent: "PaymentAgent",
      scope: ["pay-x402-approved-invoice", "respect-erc7710-spend-cap"],
      dataCategories: [],
      purpose: "Handle only approved x402 payment operations inside delegated limits."
    }
  ];

  const grants = agents.map((agent) =>
    createPermissionGrant({
      caseId,
      permissionType: "redelegation",
      delegate: agent.toAgent,
      scope: agent.scope,
      expiresAt,
      redelegatable: false,
      status: "granted"
    })
  );
  const delegations = agents.map((agent, index) => ({
    id: `delegation_${crypto.randomUUID()}`,
    caseId,
    fromAgent: "OblivionRoot" as const,
    toAgent: agent.toAgent,
    scope: agent.scope,
    dataCategories: agent.dataCategories,
    permissionGrantId: grants[index].id,
    expiresAt,
    createdAt: now.toISOString()
  }));
  const messages = agents.map((agent) => ({
    id: `agent_msg_${crypto.randomUUID()}`,
    caseId,
    fromAgent: "OblivionRoot" as const,
    toAgent: agent.toAgent,
    purpose: agent.purpose,
    redactedPayload: "case-bound task metadata only; raw identifiers stay in encrypted vault or approved TEE task payload",
    createdAt: now.toISOString()
  }));
  const timeline = delegations.map((delegation) =>
    createTimelineEvent(caseId, delegation.toAgent, `Redelegated to ${delegation.toAgent}`, delegation.scope.join(", "))
  );
  return { grants, delegations, messages, timeline };
}

export function createRelayerEvents(input: {
  caseId: string;
  sessionId?: string;
  permissionId?: string;
  status?: RelayerStatus;
  txHash?: string;
  userOpHash?: string;
  payload?: Record<string, unknown>;
}): RelayerEvent[] {
  const txHash = input.txHash;
  const userOpHash = input.userOpHash;
  let sequence: RelayerStatus[] =
    input.status && input.status === "failed" ? ["submitted", "failed"] : ["submitted", "relayed", "confirmed"];
  if (!txHash && sequence.includes("confirmed")) {
    sequence = input.status === "failed" ? ["submitted", "failed"] : ["submitted"];
  }
  return sequence.map((status) => ({
    id: `relayer_${crypto.randomUUID()}`,
    caseId: input.caseId,
    provider: "1shot",
    eventType: status,
    status,
    txHash,
    userOpHash,
    message: status === "confirmed" ? "1Shot relay confirmed for the case-bound permission." : `1Shot relay ${status}.`,
    payload: input.payload,
    createdAt: new Date().toISOString()
  }));
}

export function createTimelineEvent(
  caseId: string,
  actor: AgentTimelineEvent["actor"],
  title: string,
  summary: string
): AgentTimelineEvent {
  return {
    id: `timeline_${crypto.randomUUID()}`,
    caseId,
    actor,
    title,
    summary: redactText(summary),
    createdAt: new Date().toISOString()
  };
}

export function buildHackathonStatus(input: {
  caseId: string;
  permissions: PermissionGrant[];
  payments: PaymentSession[];
  veniceAnalyses: VeniceAnalysis[];
  delegations: AgentDelegation[];
  relayerEvents: RelayerEvent[];
  walletAddress?: string;
  store?: MemoryStore;
}): HackathonStatus {
  const walletReady = input.store && input.walletAddress
    ? walletHasCreditsOrPayment(input.store, input.walletAddress)
    : false;
  const hasOneOff = input.payments.some((session) => session.mode === "one-off") || walletReady;
  const hasSubscription = input.payments.some((session) => session.mode === "subscription") || walletReady;
  return {
    caseId: input.caseId,
    smartAccountVisible: input.permissions.some((grant) => grant.permissionType === "eip7702-authorization"),
    erc7715PermissionGranted: input.permissions.some(
      (grant) => grant.permissionType === "erc7715-advanced" && grant.status === "granted"
    ),
    x402OneOffReady: hasOneOff,
    erc7710SubscriptionReady: hasSubscription,
    veniceOutputReady: input.veniceAnalyses.length > 0,
    a2aRedelegationVisible: input.delegations.length >= 3,
    oneShotRelayerVisible: input.relayerEvents.some(
      (event) => event.provider === "1shot" && event.status === "confirmed" && !event.payload?.checklistOnly
    )
  };
}

export function pendingHackathonTracks(
  status: HackathonStatus
): Array<"x402" | "erc7710" | "venice" | "a2a" | "1shot"> {
  const pending: Array<"x402" | "erc7710" | "venice" | "a2a" | "1shot"> = [];
  if (!status.x402OneOffReady) pending.push("x402");
  if (!status.erc7710SubscriptionReady) pending.push("erc7710");
  if (!status.veniceOutputReady) pending.push("venice");
  if (!status.a2aRedelegationVisible) pending.push("a2a");
  if (!status.oneShotRelayerVisible) pending.push("1shot");
  return pending;
}

function createPermissionGrant(input: Omit<PermissionGrant, "id" | "createdAt">): PermissionGrant {
  const grant: PermissionGrant = {
    id: `permission_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  validatePermissionGrant(grant);
  return grant;
}

function containsBroadScope(scope: string[]): boolean {
  return scope.some((item) => {
    const normalized = item.toLowerCase().trim();
    return normalized === "*" || normalized === "all" || normalized.includes("unlimited") || normalized.includes("any-");
  });
}


