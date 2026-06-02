import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { buildAttestationProof, type TrustCenterConfig } from "../domain/attestation.js";
import { deadlineBasisFor, followUpDate } from "../domain/deadlines.js";
import {
  buildHackathonStatus,
  createAgentDelegationSet,
  createEip7702Authorization,
  createErc7715Permission,
  createPaymentPermission,
  createPaymentSession,
  createRelayerEvents,
  createTimelineEvent,
  createVeniceAnalysis,
  demoSmartAccountAddress,
  X402_PRODUCTS
} from "../domain/hackathon.js";
import { evaluateProposedAction, canExecuteWithApproval } from "../domain/policy.js";
import { redactText } from "../domain/redaction.js";
import { buildCaseStatus } from "../domain/status.js";
import { buildDraftText, templateForAction } from "../domain/templates.js";
import { sanitizeForLog } from "../domain/safeLogging.js";
import type {
  ActionRequest,
  ActionType,
  AgentName,
  Approval,
  AuthorityBasis,
  CaseRecord,
  EncryptedBlob,
  IdentifierCategory,
  Jurisdiction,
  PaymentMode,
  RedactedScope,
  RelayerStatus,
  RiskLevel
} from "../domain/types.js";
import { MemoryStore } from "../storage/memoryStore.js";
import { HttpError, toHttpError } from "./errors.js";
import { readJson, sendJson, sendText } from "./http.js";

export interface AppOptions {
  store?: MemoryStore;
  publicDir?: string;
  trustCenterPath?: string;
}

interface CreateCaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  retentionDays?: number;
}

interface IntakeBody {
  encryptedIntake: EncryptedBlob;
  redactedScope: RedactedScope;
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

interface ApproveBody {
  userConfirmation: string;
}

interface CaseBody {
  caseId: string;
}

interface SmartAccountBody {
  caseId: string;
  walletAddress: string;
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

interface RelayerBody {
  caseId: string;
  sessionId?: string;
  permissionId?: string;
  status?: RelayerStatus;
  txHash?: string;
  userOpHash?: string;
  payload?: Record<string, unknown>;
}

interface AgentRunBody {
  caseId: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

interface PremiumTaskBody {
  caseId: string;
  paymentSessionId?: string;
}

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const publicDir = options.publicDir ?? join(process.cwd(), "public");
  const trustCenterPath =
    options.trustCenterPath ?? process.env.TRUST_CENTER_PATH ?? join(process.cwd(), "config", "trust-center.json");

  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        const html = await readFile(join(publicDir, "index.html"), "utf8");
        sendText(response, 200, html, "text/html");
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/cases") {
        sendJson(response, 200, {
          cases: [...store.cases.values()]
            .filter((caseRecord) => !caseRecord.deletedAt)
            .map((caseRecord) => ({
              id: caseRecord.id,
              jurisdiction: caseRecord.jurisdiction,
              riskLevel: caseRecord.riskLevel,
              authorityBasis: caseRecord.authorityBasis,
              retentionDays: caseRecord.retentionDays,
              createdAt: caseRecord.createdAt,
              updatedAt: caseRecord.updatedAt,
              redactedScope: caseRecord.redactedScope ?? null,
              status: buildStatus(store, caseRecord.id)
            }))
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/cases") {
        const body = await readJson<CreateCaseBody>(request);
        const caseRecord = createCaseRecord(body);
        store.cases.set(caseRecord.id, caseRecord);
        sendJson(response, 201, { case: caseRecord, status: buildStatus(store, caseRecord.id) });
        return;
      }

      const caseReadMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
      if (method === "GET" && caseReadMatch) {
        const caseRecord = store.getCaseOrThrow(caseReadMatch[1]);
        sendJson(response, 200, {
          case: caseRecord,
          status: buildStatus(store, caseRecord.id)
        });
        return;
      }

      const intakeMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/intake$/);
      if (method === "POST" && intakeMatch) {
        const body = await readJson<IntakeBody>(request);
        const caseRecord = store.getCaseOrThrow(intakeMatch[1]);
        validateEncryptedBlob(body.encryptedIntake);
        caseRecord.encryptedIntake = body.encryptedIntake;
        caseRecord.redactedScope = sanitizeScope(body.redactedScope);
        caseRecord.updatedAt = new Date().toISOString();
        sendJson(response, 200, { case: caseRecord, status: buildStatus(store, caseRecord.id) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/propose") {
        const body = await readJson<ProposeActionBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const policy = evaluateProposedAction({
          authorityBasis: caseRecord.authorityBasis,
          actionType: body.actionType,
          destination: body.destination,
          purpose: body.purpose,
          identifiers: body.identifiers ?? [],
          dataToDisclose: body.dataToDisclose ?? [],
          plaintextPreview: body.plaintextPreview,
          sourceVerified: body.sourceVerified,
          hasApproval: false
        });

        if (!policy.allowed) {
          throw new HttpError(422, "policy-blocked", { reasons: policy.reasons });
        }

        const approval = createApproval(caseRecord.id, body);
        const action = createActionRequest(caseRecord.jurisdiction, approval.id, body);
        store.approvals.set(approval.id, approval);
        store.actions.set(action.id, action);
        sendJson(response, 201, {
          policy,
          approval,
          action,
          status: buildStatus(store, caseRecord.id)
        });
        return;
      }

      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (method === "POST" && approveMatch) {
        const approval = store.approvals.get(approveMatch[1]);
        if (!approval) throw new HttpError(404, "approval-not-found");
        const body = await readJson<ApproveBody>(request);
        if (!body.userConfirmation || body.userConfirmation.length < 8) {
          throw new HttpError(422, "user-confirmation-required");
        }
        approval.status = "approved";
        approval.approvedAt = new Date().toISOString();
        approval.userConfirmation = redactText(body.userConfirmation);
        for (const action of store.actions.values()) {
          if (action.approvalId === approval.id) action.executionStatus = "ready";
        }
        sendJson(response, 200, { approval, status: buildStatus(store, approval.caseId) });
        return;
      }

      const executeMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
      if (method === "POST" && executeMatch) {
        const action = store.actions.get(executeMatch[1]);
        if (!action) throw new HttpError(404, "action-not-found");
        const approval = store.approvals.get(action.approvalId);
        if (!approval) throw new HttpError(409, "approval-missing");
        const decision = canExecuteWithApproval(approval);
        if (!decision.allowed) {
          action.executionStatus = "blocked";
          throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
        }
        action.executionStatus = "recorded";
        action.executedAt = new Date().toISOString();
        action.executionRecord =
          "record-only executor: approved action recorded. External connector not configured for automatic submission.";
        approval.status = "used";
        sendJson(response, 200, { action, approval, status: buildStatus(store, action.caseId) });
        return;
      }

      if (method === "GET" && url.pathname === "/api/trust/attestation") {
        const config = await loadTrustCenterConfig(trustCenterPath);
        const fetchLive = url.searchParams.get("live") !== "0";
        sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
        return;
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
        return;
      }

      if (method === "GET" && url.pathname === "/api/x402/products") {
        sendJson(response, 200, {
          products: X402_PRODUCTS,
          note: "Demo catalog for x402 one-off and ERC-7710 recurring payment permissions."
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/integrations/status") {
        sendJson(response, 200, {
          mode: "demo-adapters",
          liveReady: {
            metamaskSmartAccounts: false,
            x402: false,
            erc7710: false,
            venice: Boolean(process.env.VENICE_API_KEY && process.env.VENICE_BASE_URL),
            oneShot: Boolean(process.env.ONESHOT_API_KEY && process.env.ONESHOT_BASE_URL),
            phalaAttestation: Boolean(process.env.PHALA_ATTESTATION_URL)
          },
          privacyInvariant:
            "Demo and live adapters must stay behind the same approval, redaction, logging, and attestation gates."
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/metamask/demo-session") {
        const body = await readJson<SmartAccountBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        if (!body.walletAddress || !body.walletAddress.startsWith("0x")) {
          throw new HttpError(422, "wallet-address-required");
        }
        const eip7702 = createEip7702Authorization(caseRecord.id, body.walletAddress);
        const erc7715 = createErc7715Permission(caseRecord.id);
        store.permissionGrants.set(eip7702.id, eip7702);
        store.permissionGrants.set(erc7715.id, erc7715);
        const timeline = [
          createTimelineEvent(caseRecord.id, "MetaMask", "Smart Account session", "EIP-7702 demo authorization created."),
          createTimelineEvent(
            caseRecord.id,
            "MetaMask",
            "ERC-7715 permission",
            "Advanced permission grants only task proposal, approval request, and narrow redelegation."
          )
        ];
        timeline.forEach((event) => store.agentTimeline.set(event.id, event));
        sendJson(response, 201, {
          walletAddress: redactText(body.walletAddress),
          smartAccountAddress: demoSmartAccountAddress(body.walletAddress),
          permissions: [eip7702, erc7715],
          timeline
        });
        return;
      }

      if (method === "POST" && (url.pathname === "/api/x402/one-off" || url.pathname === "/api/x402/subscription")) {
        const mode: PaymentMode = url.pathname.endsWith("subscription") ? "subscription" : "one-off";
        const body = await readJson<PaymentBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const session = createPaymentSession({
          caseId: caseRecord.id,
          mode,
          productId: body.productId,
          walletAddress: body.walletAddress ? redactText(body.walletAddress) : undefined,
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
        return;
      }

      if (method === "POST" && (url.pathname === "/api/agent/premium-task" || url.pathname === "/api/agent/monitor")) {
        const body = await readJson<PremiumTaskBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const sessions = store.paymentSessionsForCase(caseRecord.id);
        const expectedMode: PaymentMode = url.pathname.endsWith("monitor") ? "subscription" : "one-off";
        const session = body.paymentSessionId
          ? store.paymentSessions.get(body.paymentSessionId)
          : sessions.find((item) => item.mode === expectedMode);
        if (!session || session.caseId !== caseRecord.id || session.mode !== expectedMode) {
          throw new HttpError(402, "x402-payment-required", {
            products: X402_PRODUCTS.filter((product) => product.mode === expectedMode)
          });
        }
        const timeline = createTimelineEvent(
          caseRecord.id,
          "x402",
          expectedMode === "subscription" ? "Monitor entitlement checked" : "Premium task entitlement checked",
          "x402 payment session is present; cleanup still requires a separate disclosure approval."
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 200, {
          entitlement: "demo-accepted",
          session,
          nextRequired: "explicit-cleanup-approval",
          timeline
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/1shot/relay-demo") {
        const body = await readJson<RelayerBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const events = createRelayerEvents({
          caseId: caseRecord.id,
          sessionId: body.sessionId,
          permissionId: body.permissionId,
          status: body.status,
          txHash: body.txHash,
          userOpHash: body.userOpHash,
          payload: body.payload
        });
        events.forEach((event) => store.relayerEvents.set(event.id, event));
        const timeline = createTimelineEvent(
          caseRecord.id,
          "1Shot",
          "Relayer status",
          `1Shot demo status: ${events.at(-1)?.status ?? "submitted"}`
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, { events, timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/1shot/webhook") {
        const body = await readJson<RelayerBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const [event] = createRelayerEvents({
          caseId: caseRecord.id,
          sessionId: body.sessionId,
          permissionId: body.permissionId,
          status: body.status ?? "submitted",
          txHash: body.txHash,
          userOpHash: body.userOpHash,
          payload: sanitizeForLog(body.payload) as Record<string, unknown>
        }).slice(-1);
        store.relayerEvents.set(event.id, event);
        sendJson(response, 202, { event });
        return;
      }

      if (method === "GET" && url.pathname === "/api/agent/next") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, buildAgentNextStep(store, caseId));
        return;
      }

      if (method === "POST" && url.pathname === "/api/agent/run-next") {
        const body = await readJson<AgentRunBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const before = buildAgentNextStep(store, caseRecord.id);
        const walletAddress = body.walletAddress || "0x1111111111111111111111111111111111111111";
        const artifacts: unknown[] = [];

        if (before.action === "setup-smart-account") {
          const eip7702 = createEip7702Authorization(caseRecord.id, walletAddress);
          const erc7715 = createErc7715Permission(caseRecord.id);
          store.permissionGrants.set(eip7702.id, eip7702);
          store.permissionGrants.set(erc7715.id, erc7715);
          const timeline = createTimelineEvent(
            caseRecord.id,
            "MetaMask",
            "Agent prepared Smart Account permissions",
            "EIP-7702 and ERC-7715 demo permissions are ready for user review."
          );
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ smartAccountAddress: demoSmartAccountAddress(walletAddress), permissions: [eip7702, erc7715], timeline });
        } else if (before.action === "prepare-one-off-payment" || before.action === "prepare-subscription") {
          const mode: PaymentMode = before.action === "prepare-subscription" ? "subscription" : "one-off";
          const session = createPaymentSession({
            caseId: caseRecord.id,
            mode,
            productId: mode === "subscription" ? "weekly-monitor" : "broker-opt-out-packet",
            walletAddress: redactText(walletAddress),
            smartAccountAddress: body.smartAccountAddress || demoSmartAccountAddress(walletAddress)
          });
          const permission = createPaymentPermission(caseRecord.id, session);
          store.paymentSessions.set(session.id, session);
          store.permissionGrants.set(permission.id, permission);
          const timeline = createTimelineEvent(
            caseRecord.id,
            "x402",
            mode === "subscription" ? "Agent prepared monitoring subscription" : "Agent prepared one-off cleanup payment",
            "Payment is capped, expiring, case-bound, and scoped to x402."
          );
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ session, permission, timeline });
        } else if (before.action === "ask-venice") {
          const analysis = createVeniceAnalysis({
            caseId: caseRecord.id,
            kind: "classify-case",
            notes: "Agent-requested redacted case classification.",
            actionType: "broker-opt-out"
          });
          store.veniceAnalyses.set(analysis.id, analysis);
          const timeline = createTimelineEvent(caseRecord.id, "Venice", analysis.output.title, analysis.output.summary);
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ analysis, timeline });
        } else if (before.action === "delegate-agents") {
          const result = createAgentDelegationSet(caseRecord.id);
          result.grants.forEach((grant) => store.permissionGrants.set(grant.id, grant));
          result.delegations.forEach((delegation) => store.agentDelegations.set(delegation.id, delegation));
          result.messages.forEach((message) => store.agentMessages.set(message.id, message));
          result.timeline.forEach((event) => store.agentTimeline.set(event.id, event));
          artifacts.push(result);
        } else if (before.action === "relay-payment") {
          const session = store.paymentSessionsForCase(caseRecord.id).at(-1);
          const events = createRelayerEvents({ caseId: caseRecord.id, sessionId: session?.id });
          events.forEach((event) => store.relayerEvents.set(event.id, event));
          const timeline = createTimelineEvent(caseRecord.id, "1Shot", "Agent relayed latest payment", "1Shot demo relay confirmed.");
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ events, timeline });
        } else if (before.action === "prepare-cleanup-approval") {
          const proposed = createDefaultCleanupApproval(store, caseRecord);
          const timeline = createTimelineEvent(
            caseRecord.id,
            "OblivionRoot",
            "Cleanup approval prepared",
            "Broker opt-out approval is ready for user review. No external submission has occurred."
          );
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ ...proposed, timeline });
        } else if (before.action === "record-approved-action") {
          const action = store.actionsForCase(caseRecord.id).find((item) => item.executionStatus === "ready");
          if (!action) throw new HttpError(409, "ready-action-missing");
          const approval = store.approvals.get(action.approvalId);
          if (!approval) throw new HttpError(409, "approval-missing");
          const decision = canExecuteWithApproval(approval);
          if (!decision.allowed) throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
          action.executionStatus = "recorded";
          action.executedAt = new Date().toISOString();
          action.executionRecord = "record-only demo executor: approved cleanup packet recorded for user-held submission.";
          approval.status = "used";
          const timeline = createTimelineEvent(
            caseRecord.id,
            "OblivionRoot",
            "Approved cleanup action recorded",
            "Record-only execution completed. Production adapters must still follow the same approval gate."
          );
          store.agentTimeline.set(timeline.id, timeline);
          artifacts.push({ action, approval, timeline });
        }

        const after = buildAgentNextStep(store, caseRecord.id);
        sendJson(response, 200, {
          ran: before,
          next: after,
          artifacts,
          timeline: store.agentTimelineForCase(caseRecord.id),
          status: buildHackathonStatusForCase(store, caseRecord.id),
          caseStatus: buildStatus(store, caseRecord.id)
        });
        return;
      }

      if (
        method === "POST" &&
        ["/api/ai/classify-case", "/api/ai/draft-request", "/api/ai/review-approval"].includes(url.pathname)
      ) {
        const body = await readJson<VeniceBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const kind =
          url.pathname === "/api/ai/draft-request"
            ? "draft-request"
            : url.pathname === "/api/ai/review-approval"
              ? "review-approval"
              : "classify-case";
        const analysis = createVeniceAnalysis({
          caseId: caseRecord.id,
          kind,
          notes: body.notes,
          destination: body.destination,
          actionType: body.actionType
        });
        store.veniceAnalyses.set(analysis.id, analysis);
        const timeline = createTimelineEvent(caseRecord.id, "Venice", analysis.output.title, analysis.output.summary);
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, { analysis, timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/agents/delegate") {
        const body = await readJson<AgentDelegateBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const result = createAgentDelegationSet(caseRecord.id);
        result.grants.forEach((grant) => store.permissionGrants.set(grant.id, grant));
        result.delegations.forEach((delegation) => store.agentDelegations.set(delegation.id, delegation));
        result.messages.forEach((message) => store.agentMessages.set(message.id, message));
        result.timeline.forEach((event) => store.agentTimeline.set(event.id, event));
        sendJson(response, 201, result);
        return;
      }

      if (method === "POST" && url.pathname === "/api/agents/message") {
        const body = await readJson<AgentMessageBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
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
        return;
      }

      if (method === "GET" && url.pathname === "/api/agents/timeline") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, {
          permissions: store.permissionGrantsForCase(caseId),
          payments: store.paymentSessionsForCase(caseId),
          relayerEvents: store.relayerEventsForCase(caseId),
          veniceAnalyses: store.veniceAnalysesForCase(caseId),
          delegations: store.agentDelegationsForCase(caseId),
          messages: store.agentMessagesForCase(caseId),
          timeline: store.agentTimelineForCase(caseId)
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/hackathon/status") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, {
          status: buildHackathonStatusForCase(store, caseId)
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/export") {
        const body = await readJson<CaseBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        sendJson(response, 200, {
          exportedAt: new Date().toISOString(),
          case: caseRecord,
          approvals: store.approvalsForCase(caseRecord.id),
          actions: store.actionsForCase(caseRecord.id),
          exposures: store.exposuresForCase(caseRecord.id),
          followUps: store.followUpsForCase(caseRecord.id),
          paymentSessions: store.paymentSessionsForCase(caseRecord.id),
          permissionGrants: store.permissionGrantsForCase(caseRecord.id),
          relayerEvents: store.relayerEventsForCase(caseRecord.id),
          veniceAnalyses: store.veniceAnalysesForCase(caseRecord.id),
          agentDelegations: store.agentDelegationsForCase(caseRecord.id),
          agentMessages: store.agentMessagesForCase(caseRecord.id),
          agentTimeline: store.agentTimelineForCase(caseRecord.id)
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/delete") {
        const body = await readJson<CaseBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const deletedAt = new Date().toISOString();
        caseRecord.deletedAt = deletedAt;
        caseRecord.encryptedIntake = undefined;
        caseRecord.encryptedVaultPointer = "deleted";
        purgeCaseData(store, caseRecord.id);
        store.tombstones.set(caseRecord.id, deletedAt);
        sendJson(response, 200, { caseId: caseRecord.id, deletedAt, tombstone: true });
        return;
      }

      throw new HttpError(404, "not-found");
    } catch (error) {
      const httpError = toHttpError(error);
      sendJson(response, httpError.statusCode, {
        error: httpError.message,
        details: sanitizeForLog(httpError.details)
      });
    }
  }

  return {
    store,
    handler,
    server: createServer((request, response) => {
      void handler(request, response);
    })
  };
}

async function loadTrustCenterConfig(trustCenterPath: string): Promise<TrustCenterConfig> {
  const config = JSON.parse(await readFile(trustCenterPath, "utf8")) as TrustCenterConfig;
  return {
    ...config,
    attestationReportUrl: process.env.PHALA_ATTESTATION_URL ?? config.attestationReportUrl ?? null,
    phalaVerifierEndpoint: process.env.PHALA_VERIFIER_ENDPOINT ?? config.phalaVerifierEndpoint ?? null,
    maxAttestationAgeSeconds: Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? config.maxAttestationAgeSeconds ?? 600)
  };
}

function createCaseRecord(body: CreateCaseBody): CaseRecord {
  if (!["US", "EU", "UK"].includes(body.jurisdiction)) throw new HttpError(422, "unsupported-jurisdiction");
  if (!body.authorityBasis) throw new HttpError(422, "authority-basis-required");
  const now = new Date().toISOString();
  const id = `case_${crypto.randomUUID()}`;
  return {
    id,
    jurisdiction: body.jurisdiction,
    riskLevel: body.riskLevel ?? "standard",
    authorityBasis: body.authorityBasis,
    encryptedVaultPointer: `vault://${id}`,
    retentionDays: body.retentionDays ?? 90,
    createdAt: now,
    updatedAt: now
  };
}

function createApproval(caseId: string, body: ProposeActionBody): Approval {
  const now = new Date();
  return {
    id: `approval_${crypto.randomUUID()}`,
    caseId,
    actionType: body.actionType,
    destination: body.destination,
    identifiersApproved: body.identifiers ?? [],
    dataToDisclose: body.dataToDisclose ?? [],
    purpose: body.purpose,
    disclosureRisk: "Approved data will be disclosed to the named destination if execution is connected to an external adapter.",
    expiresAt: followUpDate(7, now),
    status: "pending",
    createdAt: now.toISOString()
  };
}

function createActionRequest(
  jurisdiction: Jurisdiction,
  approvalId: string,
  body: ProposeActionBody
): ActionRequest {
  return {
    id: `action_${crypto.randomUUID()}`,
    caseId: body.caseId,
    actionType: body.actionType,
    destination: body.destination,
    template: templateForAction(body.actionType, jurisdiction),
    draftText: buildDraftText({
      actionType: body.actionType,
      jurisdiction,
      destination: body.destination,
      purpose: body.purpose
    }),
    deadlineBasis: deadlineBasisFor(body.actionType, jurisdiction),
    expectedConfirmationStep: body.expectedConfirmationStep ?? "User confirms the destination and approved data before external submission.",
    approvalId,
    executionStatus: "awaiting-approval",
    createdAt: new Date().toISOString()
  };
}

function createDefaultCleanupApproval(store: MemoryStore, caseRecord: CaseRecord): { approval: Approval; action: ActionRequest } {
  const body: ProposeActionBody = {
    caseId: caseRecord.id,
    actionType: "broker-opt-out",
    destination: "Example People Search Broker",
    purpose: "Prepare a user-reviewed broker opt-out packet for synthetic demo data.",
    identifiers: ["email"],
    dataToDisclose: ["email"],
    sourceVerified: true,
    expectedConfirmationStep: "User reviews the approval card and confirms this exact disclosure before submission."
  };
  const policy = evaluateProposedAction({
    authorityBasis: caseRecord.authorityBasis,
    actionType: body.actionType,
    destination: body.destination,
    purpose: body.purpose,
    identifiers: body.identifiers,
    dataToDisclose: body.dataToDisclose,
    sourceVerified: body.sourceVerified,
    hasApproval: false
  });
  if (!policy.allowed) throw new HttpError(422, "policy-blocked", { reasons: policy.reasons });
  const approval = createApproval(caseRecord.id, body);
  const action = createActionRequest(caseRecord.jurisdiction, approval.id, body);
  store.approvals.set(approval.id, approval);
  store.actions.set(action.id, action);
  return { approval, action };
}

function validateEncryptedBlob(blob: EncryptedBlob): void {
  if (!blob || blob.alg !== "AES-256-GCM" || !blob.keyId || !blob.nonce || !blob.ciphertext) {
    throw new HttpError(422, "valid-encrypted-intake-required");
  }
}

function sanitizeScope(scope: RedactedScope): RedactedScope {
  return {
    personLabel: redactText(scope.personLabel ?? "User"),
    aliases: (scope.aliases ?? []).map(redactText),
    approvedIdentifierLabels: (scope.approvedIdentifierLabels ?? []).map(redactText),
    sensitiveConstraints: (scope.sensitiveConstraints ?? []).map(redactText)
  };
}

function buildStatus(store: MemoryStore, caseId: string) {
  const caseRecord = store.getCaseOrThrow(caseId);
  return buildCaseStatus({
    caseRecord,
    exposures: store.exposuresForCase(caseId),
    approvals: store.approvalsForCase(caseId),
    actions: store.actionsForCase(caseId),
    followUps: store.followUpsForCase(caseId)
  });
}

function purgeCaseData(store: MemoryStore, caseId: string): void {
  for (const [id, approval] of store.approvals) {
    if (approval.caseId === caseId) store.approvals.delete(id);
  }
  for (const [id, action] of store.actions) {
    if (action.caseId === caseId) store.actions.delete(id);
  }
  for (const [id, exposure] of store.exposures) {
    if (exposure.caseId === caseId) store.exposures.delete(id);
  }
  for (const [id, sourceCheck] of store.sourceChecks) {
    if (sourceCheck.caseId === caseId) store.sourceChecks.delete(id);
  }
  for (const [id, followUp] of store.followUps) {
    if (followUp.caseId === caseId) store.followUps.delete(id);
  }
  for (const [id, session] of store.paymentSessions) {
    if (session.caseId === caseId) store.paymentSessions.delete(id);
  }
  for (const [id, grant] of store.permissionGrants) {
    if (grant.caseId === caseId) store.permissionGrants.delete(id);
  }
  for (const [id, event] of store.relayerEvents) {
    if (event.caseId === caseId) store.relayerEvents.delete(id);
  }
  for (const [id, analysis] of store.veniceAnalyses) {
    if (analysis.caseId === caseId) store.veniceAnalyses.delete(id);
  }
  for (const [id, delegation] of store.agentDelegations) {
    if (delegation.caseId === caseId) store.agentDelegations.delete(id);
  }
  for (const [id, message] of store.agentMessages) {
    if (message.caseId === caseId) store.agentMessages.delete(id);
  }
  for (const [id, event] of store.agentTimeline) {
    if (event.caseId === caseId) store.agentTimeline.delete(id);
  }
}

function parseAgentName(value: string): AgentName {
  const allowed: AgentName[] = ["OblivionRoot", "ScoutAgent", "DraftAgent", "VerifierAgent", "PaymentAgent"];
  if (!allowed.includes(value as AgentName)) throw new HttpError(422, "unsupported-agent");
  return value as AgentName;
}

function buildHackathonStatusForCase(store: MemoryStore, caseId: string) {
  return buildHackathonStatus({
    caseId,
    permissions: store.permissionGrantsForCase(caseId),
    payments: store.paymentSessionsForCase(caseId),
    veniceAnalyses: store.veniceAnalysesForCase(caseId),
    delegations: store.agentDelegationsForCase(caseId),
    relayerEvents: store.relayerEventsForCase(caseId)
  });
}

function buildAgentNextStep(store: MemoryStore, caseId: string) {
  const status = buildHackathonStatusForCase(store, caseId);
  const caseStatus = buildStatus(store, caseId);
  if (!status.smartAccountVisible || !status.erc7715PermissionGranted) {
    return {
      action: "setup-smart-account",
      title: "Prepare wallet permissions",
      message:
        "I can prepare a Smart Account session and ERC-7715 permission record. You still review scope, expiry, and redelegation before real execution."
    };
  }
  if (!status.x402OneOffReady) {
    return {
      action: "prepare-one-off-payment",
      title: "Prepare one-off cleanup payment",
      message: "I can create a capped x402 payment request for one broker opt-out packet."
    };
  }
  if (!status.erc7710SubscriptionReady) {
    return {
      action: "prepare-subscription",
      title: "Prepare monitoring subscription",
      message: "I can create an ERC-7710 weekly monitor permission with a spend cap, endpoint scope, and expiry."
    };
  }
  if (!status.veniceOutputReady) {
    return {
      action: "ask-venice",
      title: "Ask Venice for redacted analysis",
      message: "I can classify the redacted case context and turn it into a cleanup task proposal."
    };
  }
  if (!status.a2aRedelegationVisible) {
    return {
      action: "delegate-agents",
      title: "Delegate specialist agents",
      message: "I can redelegate narrow roles to Scout, Draft, Verifier, and Payment agents."
    };
  }
  if (!status.oneShotRelayerVisible) {
    return {
      action: "relay-payment",
      title: "Relay latest payment",
      message: "I can send the latest payment permission through the 1Shot demo relayer and track status."
    };
  }
  if (caseStatus.approvalsNeeded.length === 0 && caseStatus.actionsReady.length === 0 && caseStatus.submittedActions.length === 0) {
    return {
      action: "prepare-cleanup-approval",
      title: "Prepare cleanup approval",
      message:
        "I can draft the first broker opt-out approval card. It names the destination, data categories, purpose, risk, and expiration."
    };
  }
  if (caseStatus.approvalsNeeded.length > 0) {
    return {
      action: "await-user-approval",
      title: "Waiting for approval",
      message:
        "Review the approval card. I cannot execute or disclose anything until you approve that exact action."
    };
  }
  if (caseStatus.actionsReady.length > 0) {
    return {
      action: "record-approved-action",
      title: "Record approved action",
      message:
        "I can record the approved cleanup packet as ready for user-held submission. This demo executor does not contact external brokers."
    };
  }
  return {
    action: "complete",
    title: "Full demo complete",
    message: "All hackathon tracks are represented and the approved cleanup action has been recorded without external disclosure."
  };
}
