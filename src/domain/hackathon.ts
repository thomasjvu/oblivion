import { followUpDate } from "./deadlines.js";
import { walletHasCreditsOrPayment } from "./credits.js";
import { createTimelineEvent } from "./agentTimeline.js";
import {
  createPermissionGrant,
  validatePermissionGrant
} from "./payments/sessions.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type {
  AgentDelegation,
  AgentMessage,
  AgentName,
  AgentTimelineEvent,
  HackathonStatus,
  IdentifierCategory,
  PaymentSession,
  PermissionGrant,
  RelayerEvent,
  VeniceAnalysis
} from "./types.js";

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