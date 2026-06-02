import { createHash } from "node:crypto";
import { followUpDate } from "./deadlines.js";
import { redactText } from "./redaction.js";
import type {
  ActionType,
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
  VeniceAnalysisKind,
  X402PaymentRequest
} from "./types.js";

export const X402_PRODUCTS: PaymentProduct[] = [
  {
    id: "broker-opt-out-packet",
    name: "Broker opt-out packet",
    mode: "one-off",
    description: "Prepare one approved people-search broker opt-out packet from an encrypted case.",
    amountUsd: 5,
    token: "USDC",
    network: "base",
    x402Endpoint: "/api/agent/premium-task",
    requiredPermission: "erc7710-payment"
  },
  {
    id: "weekly-monitor",
    name: "Weekly cleanup monitor",
    mode: "subscription",
    description: "Recheck approved sources weekly and prepare follow-ups when data reappears.",
    amountUsd: 9,
    token: "USDC",
    network: "base",
    cadence: "weekly",
    x402Endpoint: "/api/agent/monitor",
    requiredPermission: "erc7710-payment"
  }
];

export function productForMode(mode: PaymentMode, productId?: string): PaymentProduct {
  const product = X402_PRODUCTS.find((item) => item.mode === mode && (!productId || item.id === productId));
  if (!product) throw Object.assign(new Error("payment-product-not-found"), { statusCode: 404 });
  return product;
}

export function demoSmartAccountAddress(walletAddress: string): string {
  return `0x${createHash("sha256").update(walletAddress.toLowerCase()).digest("hex").slice(0, 40)}`;
}

export function createEip7702Authorization(caseId: string, walletAddress: string): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "eip7702-authorization",
    delegate: demoSmartAccountAddress(walletAddress),
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
  const x402Request: X402PaymentRequest = {
    version: "x402-demo-v1",
    endpoint: product.x402Endpoint,
    amountUsd: product.amountUsd,
    token: product.token,
    network: product.network,
    memo: `${product.name} for encrypted Oblivion case`,
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
      product.mode === "subscription" ? "pay-weekly-monitor-invoices" : "pay-one-off-cleanup-packet",
      "x402-only",
      "case-bound"
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

export function createVeniceAnalysis(input: {
  caseId: string;
  kind: VeniceAnalysisKind;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
}): VeniceAnalysis {
  const redacted = redactText(input.notes || "Encrypted case summary unavailable to server.");
  const kind = input.kind;
  const actionType = input.actionType ?? "broker-opt-out";
  const destination = redactText(input.destination || "approved destination");
  const output = buildVeniceOutput(kind, redacted, destination, actionType);
  return {
    id: `venice_${crypto.randomUUID()}`,
    caseId: input.caseId,
    kind,
    model: process.env.VENICE_MODEL ?? "venice-demo-redacted-reasoner",
    redactedInputSummary: redacted,
    output,
    createdAt: new Date().toISOString()
  };
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
  const caseSeed = `${input.caseId}:${input.sessionId ?? input.permissionId ?? "demo"}`;
  const txHash = input.txHash ?? `0x${createHash("sha256").update(`tx:${caseSeed}`).digest("hex")}`;
  const userOpHash = input.userOpHash ?? `0x${createHash("sha256").update(`userop:${caseSeed}`).digest("hex")}`;
  const sequence: RelayerStatus[] = input.status && input.status === "failed" ? ["submitted", "failed"] : ["submitted", "relayed", "confirmed"];
  return sequence.map((status) => ({
    id: `relayer_${crypto.randomUUID()}`,
    caseId: input.caseId,
    provider: "1shot",
    eventType: status,
    status,
    txHash,
    userOpHash,
    message: status === "confirmed" ? "1Shot demo relay confirmed for the case-bound permission." : `1Shot demo relay ${status}.`,
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
}): HackathonStatus {
  return {
    caseId: input.caseId,
    smartAccountVisible: input.permissions.some((grant) => grant.permissionType === "eip7702-authorization"),
    erc7715PermissionGranted: input.permissions.some(
      (grant) => grant.permissionType === "erc7715-advanced" && grant.status === "granted"
    ),
    x402OneOffReady: input.payments.some((session) => session.mode === "one-off"),
    erc7710SubscriptionReady: input.payments.some((session) => session.mode === "subscription"),
    veniceOutputReady: input.veniceAnalyses.length > 0,
    a2aRedelegationVisible: input.delegations.length >= 3,
    oneShotRelayerVisible: input.relayerEvents.some((event) => event.provider === "1shot")
  };
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

function buildVeniceOutput(
  kind: VeniceAnalysisKind,
  redacted: string,
  destination: string,
  actionType: ActionType
): VeniceAnalysis["output"] {
  if (kind === "classify-case") {
    return {
      title: "Redacted case classification",
      summary: `Venice demo adapter classified the redacted case context as ${actionType} ready without receiving raw identifiers.`,
      risk: redacted.toLowerCase().includes("address") ? "high-risk-safety" : "standard",
      recommendedTask: actionType,
      nextSteps: ["Verify official removal path", "Prepare exact approval", "Keep raw identifiers in the encrypted vault"]
    };
  }
  if (kind === "draft-request") {
    return {
      title: "Removal request draft",
      summary: `Draft prepared for ${destination} using redacted case context.`,
      recommendedTask: actionType,
      draftText:
        `Please remove the matching profile associated with the approved identifiers. ` +
        `This request is limited to the user-confirmed case scope and should not be used for marketing, resale, or further disclosure.`,
      nextSteps: ["Review destination", "Approve exact disclosure", "Submit only through approved channel"]
    };
  }
  return {
    title: "Approval review",
    summary: "Venice demo adapter reviewed the approval for over-disclosure and missing user confirmation.",
    recommendedTask: actionType,
    approvalExplanation:
      "This action should disclose only the selected data categories to the named destination and expires automatically.",
    nextSteps: ["Check destination", "Check data categories", "Require passing attestation for managed execution"]
  };
}
