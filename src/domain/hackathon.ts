import { createHash } from "node:crypto";
import { followUpDate } from "./deadlines.js";
import { isX402Configured } from "./integrations.js";
import { redactText } from "./redaction.js";
import { runVeniceAnalysis } from "./venice.js";
import type { MemoryStore } from "../storage/memoryStore.js";
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
  X402PaymentRequest
} from "./types.js";

export const X402_PRODUCTS: PaymentProduct[] = [
  {
    id: "broker-opt-out-packet",
    name: "One-off cleanup run",
    mode: "one-off",
    description: "$1 USDC for a single supervised cleanup run with capped agent assistance.",
    amountUsd: 1,
    token: "USDC",
    network: "base",
    x402Endpoint: "/api/agent/premium-task",
    requiredPermission: "erc7710-payment"
  },
  {
    id: "weekly-monitor",
    name: "Weekly review & cleanup",
    mode: "subscription",
    description: "$5 USDC/month for weekly exposure rechecks and follow-up cleanup prep.",
    amountUsd: 5,
    token: "USDC",
    network: "base",
    cadence: "monthly",
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

export function pendingHackathonTracks(status: HackathonStatus): Array<"x402" | "venice" | "a2a" | "1shot"> {
  const pending: Array<"x402" | "venice" | "a2a" | "1shot"> = [];
  if (!status.x402OneOffReady) pending.push("x402");
  if (!status.veniceOutputReady) pending.push("venice");
  if (!status.a2aRedelegationVisible) pending.push("a2a");
  if (!status.oneShotRelayerVisible) pending.push("1shot");
  return pending;
}

function authorizePaymentSession(session: PaymentSession): PaymentSession {
  if (isX402Configured() || session.status === "paid") return session;
  return { ...session, status: "authorized", updatedAt: new Date().toISOString() };
}

function walletContextForCase(store: MemoryStore, caseId: string, input?: { walletAddress?: string; smartAccountAddress?: string }) {
  const eip7702 = store.permissionGrantsForCase(caseId).find((grant) => grant.permissionType === "eip7702-authorization");
  return {
    walletAddress: input?.walletAddress,
    smartAccountAddress: input?.smartAccountAddress || eip7702?.delegate
  };
}

export async function completePendingHackathonTracks(input: {
  store: MemoryStore;
  caseId: string;
  walletAddress?: string;
  smartAccountAddress?: string;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
}): Promise<{
  completed: Array<"x402" | "venice" | "a2a" | "1shot">;
  status: HackathonStatus;
  artifacts: {
    payments: PaymentSession[];
    veniceAnalyses: VeniceAnalysis[];
    delegations: AgentDelegation[];
    relayerEvents: RelayerEvent[];
    timeline: AgentTimelineEvent[];
  };
}> {
  const completed: Array<"x402" | "venice" | "a2a" | "1shot"> = [];
  const payments: PaymentSession[] = [];
  const veniceAnalyses: VeniceAnalysis[] = [];
  const delegations: AgentDelegation[] = [];
  const relayerEvents: RelayerEvent[] = [];
  const timeline: AgentTimelineEvent[] = [];
  const { walletAddress, smartAccountAddress } = walletContextForCase(input.store, input.caseId, input);

  let status = buildHackathonStatus({
    caseId: input.caseId,
    permissions: input.store.permissionGrantsForCase(input.caseId),
    payments: input.store.paymentSessionsForCase(input.caseId),
    veniceAnalyses: input.store.veniceAnalysesForCase(input.caseId),
    delegations: input.store.agentDelegationsForCase(input.caseId),
    relayerEvents: input.store.relayerEventsForCase(input.caseId)
  });

  if (!status.x402OneOffReady) {
    const created = createPaymentSession({
      caseId: input.caseId,
      mode: "one-off",
      productId: "broker-opt-out-packet",
      walletAddress: walletAddress ? redactText(walletAddress) : undefined,
      smartAccountAddress
    });
    const session = authorizePaymentSession(created);
    const permission = createPaymentPermission(input.caseId, session);
    input.store.paymentSessions.set(session.id, session);
    input.store.permissionGrants.set(permission.id, permission);
    payments.push(session);
    const event = createTimelineEvent(
      input.caseId,
      "x402",
      "One-off payment prepared",
      `${session.productId} requires ERC-7710 scoped payment permission before execution.`
    );
    input.store.agentTimeline.set(event.id, event);
    timeline.push(event);
    completed.push("x402");
    status = { ...status, x402OneOffReady: true };
  }

  if (!status.veniceOutputReady) {
    const analysis = await runVeniceAnalysis({
      caseId: input.caseId,
      kind: "classify-case",
      notes: input.notes,
      destination: input.destination,
      actionType: input.actionType
    });
    input.store.veniceAnalyses.set(analysis.id, analysis);
    veniceAnalyses.push(analysis);
    const event = createTimelineEvent(input.caseId, "Venice", analysis.output.title, analysis.output.summary);
    input.store.agentTimeline.set(event.id, event);
    timeline.push(event);
    completed.push("venice");
    status = { ...status, veniceOutputReady: true };
  }

  if (!status.a2aRedelegationVisible) {
    const result = createAgentDelegationSet(input.caseId);
    result.grants.forEach((grant) => input.store.permissionGrants.set(grant.id, grant));
    result.delegations.forEach((delegation) => {
      input.store.agentDelegations.set(delegation.id, delegation);
      delegations.push(delegation);
    });
    result.messages.forEach((message) => input.store.agentMessages.set(message.id, message));
    result.timeline.forEach((event) => {
      input.store.agentTimeline.set(event.id, event);
      timeline.push(event);
    });
    completed.push("a2a");
    status = { ...status, a2aRedelegationVisible: true };
  }

  if (!status.oneShotRelayerVisible) {
    const latestSession =
      input.store.paymentSessionsForCase(input.caseId).find((session) => session.mode === "one-off") ||
      input.store.paymentSessionsForCase(input.caseId).at(-1);
    const events = createRelayerEvents({
      caseId: input.caseId,
      sessionId: latestSession?.id
    });
    events.forEach((relayerEvent) => {
      input.store.relayerEvents.set(relayerEvent.id, relayerEvent);
      relayerEvents.push(relayerEvent);
    });
    const event = createTimelineEvent(
      input.caseId,
      "1Shot",
      "Relayer status",
      `1Shot demo relay: ${events.at(-1)?.status ?? "submitted"}`
    );
    input.store.agentTimeline.set(event.id, event);
    timeline.push(event);
    completed.push("1shot");
    status = { ...status, oneShotRelayerVisible: true };
  }

  return {
    completed,
    status,
    artifacts: { payments, veniceAnalyses, delegations, relayerEvents, timeline }
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


