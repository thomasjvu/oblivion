import type { IncomingMessage, ServerResponse } from "node:http";
import { assertPartnerOwnsCase, requirePartnerAuth } from "../auth.js";
import { HttpError } from "../errors.js";
import { readJson, readRawBody, sendJson } from "../http.js";
import { buildAgentPlanView, CLEANUP_PRESETS } from "../../domain/cleanup.js";
import { createCaseRecord } from "../../domain/cases.js";
import { buildAttestationProof, type TrustCenterConfig } from "../../domain/attestation.js";

import { findPartnerCaseByExternalRef, runPartnerAgentUntilBlocked } from "../../domain/partnerAgent.js";
import { buildPartnerCaseExport, listPartnerDataAccess, recordPartnerDataAccess } from "../../domain/partnerAudit.js";
import {
  closePartnerInvoicePeriod,
  getPartnerInvoice,
  invoiceView,
  listPartnerInvoices
} from "../../domain/partnerInvoices.js";
import { creditPartnerPool, meterPartnerUsage, partnerBillingView, partnerUsageSummary } from "../../domain/partnerBilling.js";
import { partnerPresetAllowlist, rotatePartnerApiKey } from "../../domain/partners.js";
import { buildPartnerCaseStatus, buildPartnerRiskSummary } from "../../domain/partnerStatus.js";
import { buildPartnerRuntimeBadge } from "../../domain/partnerRuntime.js";
import { purgeCaseData } from "../../domain/purgeCase.js";
import { runCleanupAgentStep } from "../../domain/agentRunner.js";
import { buildStatus } from "../../domain/orchestration.js";
import {
  dispatchPartnerWebhook,
  emitCaseDeletedWebhook,
  emitCaseWebhook,
  notifyCasePendingApprovals,
  partnerWebhookInboxUrl,
  processDueWebhookRetries,
  retryFailedWebhookDeliveries,
  retryWebhookDelivery,
  storeWebhookInboxEntry,
  verifyWebhookSignature
} from "../../domain/webhooks.js";
import type {
  AuthorityBasis,
  IdentifierCategory,
  Jurisdiction,
  PartnerWebhookEvent,
  RedactedScope,
  RiskLevel
} from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";
import {
  handleApplyPreset,
  handleApprove,
  handleCaseDiscover,
  handleCaseIntake,
  handleExecute,
  handleFindingDecision,
  type ApplyPresetBody,
  type IntakeBody
} from "../handlers/caseHandlers.js";

export interface V1Context {
  store: MemoryStore;
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>;
}

interface CreateV1CaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  externalRef?: string;
  callbackUrl?: string;
  retentionDays?: number;
}

interface WebhookBody {
  url: string;
  secret?: string;
  events?: string[];
}

export async function handleV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: V1Context
): Promise<boolean> {
  const { store, loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (!pathname.startsWith("/v1/")) return false;

  if (method === "GET" && pathname === "/v1/trust/attestation") {
    const config = await loadTrustCenterConfig();
    const fetchLive = url.searchParams.get("live") !== "0";
    sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/runtime") {
    sendJson(response, 200, await buildPartnerRuntimeBadge(loadTrustCenterConfig, url.searchParams.get("live") !== "0"));
    return true;
  }

  const inboxPostMatch = pathname.match(/^\/v1\/partners\/([^/]+)\/webhook-inbox$/);
  if (method === "POST" && inboxPostMatch) {
    const partner = store.partners.get(inboxPostMatch[1]);
    if (!partner) throw new HttpError(404, "partner-not-found");
    const rawBody = await readRawBody(request);
    const timestamp = String(request.headers["x-oblivion-timestamp"] ?? "");
    const signature = String(request.headers["x-oblivion-signature"] ?? "");
    const event = String(request.headers["x-oblivion-event"] ?? "case.created") as PartnerWebhookEvent;
    const secret = partner.webhookSecret ?? partner.id;
    const signatureValid = verifyWebhookSignature(secret, timestamp, rawBody, signature);
    if (!signatureValid) throw new HttpError(401, "webhook-signature-invalid");
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid-webhook-json");
    }
    const entry = storeWebhookInboxEntry(store, partner.id, event, payload, signatureValid);
    sendJson(response, 200, { received: true, id: entry.id });
    return true;
  }

  if (method === "GET" && pathname === "/v1/trust/privacy") {
    sendJson(response, 200, {
      storedPlaintext: false,
      serverCanDecryptCaseVault: false,
      partnerCanDecryptCaseVault: false,
      rawPiiToNonTeeLlm: false,
      defaultExecutor: "record-only",
      sensitiveActionRequiresApproval: true,
      thirdPartyDisclosureStillPossible: true,
      partnerIntegrationModel:
        "Partners receive redacted metadata and lifecycle webhooks. Plaintext stays in the user browser vault until explicit per-action approval.",
      message:
        "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties. Partners must not request vault decryption."
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/openapi.json") {
    sendJson(response, 200, {
      redirect: "/docs/openapi-v1.yaml",
      note: "See https://oblivion-docs.phantasy.bot/docs/developers/partner-api"
    });
    return true;
  }

  const adminCreditMatch = pathname.match(/^\/v1\/admin\/partners\/([^/]+)\/credits$/);
  if (method === "POST" && adminCreditMatch) {
    const adminToken = process.env.OBLIVION_PARTNER_ADMIN_TOKEN?.trim();
    const provided = String(request.headers["x-oblivion-admin-token"] ?? "");
    if (!adminToken || provided !== adminToken) throw new HttpError(401, "admin-token-required");
    const target = store.partners.get(adminCreditMatch[1]);
    if (!target) throw new HttpError(404, "partner-not-found");
    const body = await readJson<{ credits?: number }>(request);
    if (!body.credits) throw new HttpError(422, "credits-required");
    creditPartnerPool(store, target, body.credits);
    sendJson(response, 200, { partnerId: target.id, balanceCredits: target.balanceCredits });
    return true;
  }

  const partner = requirePartnerAuth(request, store);

  if (method === "GET" && pathname === "/v1/partners/me") {
    sendJson(response, 200, {
      partner: {
        id: partner.id,
        name: partner.name,
        environment: partner.environment,
        balanceCredits: partner.balanceCredits,
        webhookUrl: partner.webhookUrl ?? null,
        webhookEvents: partner.webhookEvents,
        keyRotatedAt: partner.keyRotatedAt ?? null
      },
      billing: partnerBillingView(partner)
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/partners/me/rotate-key") {
    const rotated = rotatePartnerApiKey(partner);
    store.partners.set(partner.id, rotated.partner);
    sendJson(response, 200, {
      partnerId: rotated.partner.id,
      environment: rotated.partner.environment,
      apiKey: rotated.apiKey,
      keyRotatedAt: rotated.partner.keyRotatedAt,
      warning: "Store this key now. It will not be shown again."
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/presets") {
    const allowlist = partnerPresetAllowlist();
    sendJson(response, 200, {
      presets: CLEANUP_PRESETS.filter((preset) => allowlist.has(preset.id))
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/usage") {
    sendJson(response, 200, partnerUsageSummary(store, partner.id));
    return true;
  }

  if (method === "GET" && pathname === "/v1/billing/balance") {
    sendJson(response, 200, partnerBillingView(partner));
    return true;
  }

  if (method === "GET" && pathname === "/v1/billing/invoices") {
    sendJson(response, 200, {
      invoices: listPartnerInvoices(store, partner.id).map(invoiceView)
    });
    return true;
  }

  const invoiceMatch = pathname.match(/^\/v1\/billing\/invoices\/([^/]+)$/);
  if (method === "GET" && invoiceMatch) {
    const invoice = getPartnerInvoice(store, partner.id, invoiceMatch[1]);
    sendJson(response, 200, { invoice: invoiceView(invoice) });
    return true;
  }

  if (method === "POST" && pathname === "/v1/billing/invoices/close") {
    const body = await readJson<{ period?: string }>(request);
    if (!body.period) throw new HttpError(422, "invoice-period-required");
    const invoice = closePartnerInvoicePeriod(store, partner, body.period);
    sendJson(response, 200, { invoice: invoiceView(invoice) });
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/data-access") {
    const caseId = url.searchParams.get("caseId") ?? undefined;
    const limit = Number(url.searchParams.get("limit") || "50");
    sendJson(response, 200, {
      events: listPartnerDataAccess(store, partner.id, { caseId, limit })
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks") {
    const body = await readJson<WebhookBody>(request);
    if (!body.url?.startsWith("https://")) throw new HttpError(422, "webhook-url-https-required");
    partner.webhookUrl = body.url.trim();
    partner.webhookSecret = body.secret?.trim() || partner.webhookSecret || partner.id;
    if (Array.isArray(body.events) && body.events.length > 0) {
      partner.webhookEvents = body.events as typeof partner.webhookEvents;
    }
    partner.updatedAt = new Date().toISOString();
    store.partners.set(partner.id, partner);
    sendJson(response, 200, {
      partnerId: partner.id,
      webhookUrl: partner.webhookUrl,
      webhookEvents: partner.webhookEvents
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/webhooks/deliveries") {
    await processDueWebhookRetries(store);
    const statusFilter = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") || "50");
    const deliveries = [...store.webhookDeliveries.values()]
      .filter((delivery) => delivery.partnerId === partner.id)
      .filter((delivery) => (statusFilter ? delivery.status === statusFilter : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((delivery) => ({
        id: delivery.id,
        event: delivery.event,
        caseId: delivery.caseId,
        status: delivery.status,
        attemptCount: delivery.attemptCount ?? 1,
        nextRetryAt: delivery.nextRetryAt ?? null,
        responseStatus: delivery.responseStatus,
        error: delivery.error,
        createdAt: delivery.createdAt,
        deliveredAt: delivery.deliveredAt
      }));
    sendJson(response, 200, { deliveries });
    return true;
  }

  const deliveryRetryMatch = pathname.match(/^\/v1\/webhooks\/deliveries\/([^/]+)\/retry$/);
  if (method === "POST" && deliveryRetryMatch) {
    const delivery = await retryWebhookDelivery(store, partner, deliveryRetryMatch[1]);
    sendJson(response, 200, { delivery });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/deliveries/retry-failed") {
    const body = await readJson<{ limit?: number }>(request);
    const deliveries = await retryFailedWebhookDeliveries(store, partner, body.limit ?? 10);
    sendJson(response, 200, { retried: deliveries.length, deliveries });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/register-inbox") {
    const apiBase = apiBaseFromRequest(request);
    partner.webhookUrl = partnerWebhookInboxUrl(partner.id, apiBase);
    partner.webhookSecret = partner.webhookSecret ?? partner.id;
    partner.updatedAt = new Date().toISOString();
    store.partners.set(partner.id, partner);
    sendJson(response, 200, {
      partnerId: partner.id,
      webhookUrl: partner.webhookUrl,
      note: "Webhook deliveries will appear in GET /v1/partners/me/webhook-inbox"
    });
    return true;
  }

  if (method === "POST" && pathname === "/v1/webhooks/test") {
    const body = await readJson<{ event?: PartnerWebhookEvent; caseId?: string }>(request);
    const event = body.event ?? "case.created";
    const delivery = await dispatchPartnerWebhook(store, partner, event, {
      caseId: body.caseId,
      test: true
    });
    sendJson(response, 200, { delivery: delivery ?? null, configured: Boolean(partner.webhookUrl) });
    return true;
  }

  if (method === "GET" && pathname === "/v1/partners/me/webhook-inbox") {
    const entries = [...store.partnerWebhookInbox.values()]
      .filter((entry) => entry.partnerId === partner.id)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, 50);
    sendJson(response, 200, { entries });
    return true;
  }

  if (method === "POST" && pathname === "/v1/cases") {
    const body = await readJson<CreateV1CaseBody>(request);
    if (body.externalRef) {
      const existing = findPartnerCaseByExternalRef(store, partner.id, body.externalRef);
      if (existing) {
        sendJson(response, 200, {
          case: summarizePartnerCase(existing),
          status: buildPartnerCaseStatus(store, existing.id),
          idempotent: true
        });
        return true;
      }
    }
    meterPartnerUsage(store, partner, "case");
    const { caseRecord } = createCaseRecord({
      ...body,
      partnerId: partner.id
    });
    store.cases.set(caseRecord.id, caseRecord);
    await emitCaseWebhook(store, caseRecord.id, "case.created", {
      externalRef: caseRecord.externalRef,
      jurisdiction: caseRecord.jurisdiction
    });
    sendJson(response, 201, {
      case: summarizePartnerCase(caseRecord),
      status: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  if (method === "GET" && pathname === "/v1/cases") {
    const externalRef = url.searchParams.get("externalRef") ?? undefined;
    let cases = store.casesForPartner(partner.id);
    if (externalRef) cases = cases.filter((item) => item.externalRef === externalRef);
    sendJson(response, 200, {
      cases: cases.map((caseRecord) => ({
        ...summarizePartnerCase(caseRecord),
        status: buildPartnerCaseStatus(store, caseRecord.id)
      }))
    });
    return true;
  }

  const caseReadMatch = pathname.match(/^\/v1\/cases\/([^/]+)$/);
  if (method === "GET" && caseReadMatch) {
    const caseRecord = store.getCaseOrThrow(caseReadMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, {
      case: summarizePartnerCase(caseRecord),
      status: buildStatus(store, caseRecord.id),
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const intakeMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/intake$/);
  if (method === "POST" && intakeMatch) {
    const body = await readJson<IntakeBody>(request);
    const caseRecord = store.getCaseOrThrow(intakeMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    handleCaseIntake(store, caseRecord, body);
    sendJson(response, 200, { case: summarizePartnerCase(caseRecord), status: buildStatus(store, caseRecord.id) });
    return true;
  }

  const presetMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/preset$/);
  if (method === "POST" && presetMatch) {
    const body = await readJson<ApplyPresetBody>(request);
    const allowlist = partnerPresetAllowlist();
    if (!allowlist.has(body.presetId)) throw new HttpError(422, "preset-not-available-for-partners");
    const caseRecord = store.getCaseOrThrow(presetMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const { preset, plan } = await handleApplyPreset(store, caseRecord, body, { emitWebhook: true });
    sendJson(response, 201, {
      preset,
      plan,
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const planMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/plan$/);
  if (method === "GET" && planMatch) {
    const caseRecord = store.getCaseOrThrow(planMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const plan = store.agentPlanForCase(caseRecord.id);
    sendJson(response, 200, {
      plan: plan ? buildAgentPlanView(plan) : null,
      connectorResults: store.connectorResultsForCase(caseRecord.id),
      timeline: store.agentTimelineForCase(caseRecord.id)
    });
    return true;
  }

  const runMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/run$/);
  if (method === "POST" && runMatch) {
    const caseRecord = store.getCaseOrThrow(runMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const before = store.agentPlanForCase(caseRecord.id)?.currentStep;
    const result = await runCleanupAgentStep({
      store,
      caseRecord,
      trustCenterConfig: loadTrustCenterConfig,
      highAutonomy: false
    });
    const after = store.agentPlanForCase(caseRecord.id)?.currentStep;
    if (after && after !== before) {
      await emitCaseWebhook(store, caseRecord.id, "case.phase_changed", {
        currentStep: after,
        blockedReasons: result.plan?.blockedReasons ?? []
      });
    }
    await notifyCasePendingApprovals(store, caseRecord.id);
    sendJson(response, 200, result);
    return true;
  }

  const runUntilMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/run-until-blocked$/);
  if (method === "POST" && runUntilMatch) {
    const caseRecord = store.getCaseOrThrow(runUntilMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const body = await readJson<{ maxIterations?: number }>(request);
    const result = await runPartnerAgentUntilBlocked({
      store,
      caseRecord,
      trustCenterConfig: loadTrustCenterConfig,
      maxIterations: body.maxIterations
    });
    sendJson(response, 200, result);
    return true;
  }

  const exportMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/export$/);
  if (method === "GET" && exportMatch) {
    const caseRecord = store.getCaseOrThrow(exportMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    recordPartnerDataAccess(store, {
      partnerId: partner.id,
      caseId: caseRecord.id,
      action: "export",
      source: "v1"
    });
    sendJson(response, 200, buildPartnerCaseExport(store, caseRecord));
    return true;
  }

  const deleteMatch = pathname.match(/^\/v1\/cases\/([^/]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const caseRecord = store.getCaseOrThrow(deleteMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const deletedAt = new Date().toISOString();
    recordPartnerDataAccess(store, {
      partnerId: partner.id,
      caseId: caseRecord.id,
      action: "delete",
      source: "v1"
    });
    await emitCaseDeletedWebhook(store, caseRecord.id);
    caseRecord.deletedAt = deletedAt;
    caseRecord.encryptedIntake = undefined;
    caseRecord.encryptedVaultPointer = "deleted";
    purgeCaseData(store, caseRecord.id);
    store.tombstones.set(caseRecord.id, deletedAt);
    sendJson(response, 200, { caseId: caseRecord.id, deletedAt, tombstone: true });
    return true;
  }

  const statusMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/status$/);
  if (method === "GET" && statusMatch) {
    const caseRecord = store.getCaseOrThrow(statusMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, buildPartnerCaseStatus(store, caseRecord.id));
    return true;
  }

  const riskMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/risk-summary$/);
  if (method === "GET" && riskMatch) {
    const caseRecord = store.getCaseOrThrow(riskMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, buildPartnerRiskSummary(store, caseRecord.id));
    return true;
  }

  const timelineMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/timeline$/);
  if (method === "GET" && timelineMatch) {
    const caseRecord = store.getCaseOrThrow(timelineMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, { timeline: store.agentTimelineForCase(caseRecord.id) });
    return true;
  }

  const exposuresMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/exposures$/);
  if (method === "GET" && exposuresMatch) {
    const caseRecord = store.getCaseOrThrow(exposuresMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const status = buildStatus(store, caseRecord.id);
    sendJson(response, 200, {
      exposures: status.findings,
      pending: status.pendingFindings,
      confirmed: status.confirmedFindings
    });
    return true;
  }

  const discoverMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/discover$/);
  if (method === "POST" && discoverMatch) {
    const caseRecord = store.getCaseOrThrow(discoverMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    meterPartnerUsage(store, partner, "discover", caseRecord.id);
    const body = await readJson<{ pastedUrls?: string[] }>(request);
    const plan = store.agentPlanForCase(caseRecord.id);
    const { discovered, discovery, discoveryPlan } = await handleCaseDiscover(
      store,
      caseRecord,
      body,
      plan?.presetId
    );
    sendJson(response, 201, {
      discovered,
      discovery,
      discoveryPlan,
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const exposureDecisionMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/exposures\/([^/]+)\/(confirm|reject)$/);
  if (method === "POST" && exposureDecisionMatch) {
    const caseRecord = store.getCaseOrThrow(exposureDecisionMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const decision = exposureDecisionMatch[3] === "confirm" ? "confirmed" : "rejected";
    const { exposure } = handleFindingDecision(store, caseRecord, exposureDecisionMatch[2], decision, {
      notFoundError: "exposure-not-found",
      createTimeline: false
    });
    sendJson(response, 200, { exposure, partnerStatus: buildPartnerCaseStatus(store, caseRecord.id) });
    return true;
  }

  const approvalsMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/approvals$/);
  if (method === "GET" && approvalsMatch) {
    const caseRecord = store.getCaseOrThrow(approvalsMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    const approvals = store.approvalsForCase(caseRecord.id);
    sendJson(response, 200, {
      pending: approvals.filter((approval) => approval.status === "pending"),
      history: approvals.filter((approval) => approval.status !== "pending"),
      actions: store.actionsForCase(caseRecord.id)
    });
    return true;
  }

  const approveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const body = await readJson<{ userConfirmation: string }>(request);
    const { approval, caseId } = await handleApprove(store, approveMatch[1], body);
    const caseRecord = store.getCaseOrThrow(caseId);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, { approval, partnerStatus: buildPartnerCaseStatus(store, caseRecord.id) });
    return true;
  }

  const executeMatch = pathname.match(/^\/v1\/actions\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const body = await readJson<{ hashPrefix?: string; emailLabel?: string; sourceUrl?: string }>(request);
    const { action, executed, caseRecord } = await handleExecute(
      store,
      executeMatch[1],
      body,
      loadTrustCenterConfig
    );
    assertPartnerOwnsCase(partner, caseRecord);
    meterPartnerUsage(store, partner, "execute", caseRecord.id);
    sendJson(response, 200, {
      action,
      executorMode: executed.mode,
      connectorResult: executed.connectorResult,
      partnerStatus: buildPartnerCaseStatus(store, caseRecord.id)
    });
    return true;
  }

  const actionsMatch = pathname.match(/^\/v1\/cases\/([^/]+)\/actions$/);
  if (method === "GET" && actionsMatch) {
    const caseRecord = store.getCaseOrThrow(actionsMatch[1]);
    assertPartnerOwnsCase(partner, caseRecord);
    sendJson(response, 200, { actions: store.actionsForCase(caseRecord.id) });
    return true;
  }

  throw new HttpError(404, "not-found");
}

function summarizePartnerCase(caseRecord: {
  id: string;
  jurisdiction: string;
  riskLevel: string;
  authorityBasis: string;
  partnerId?: string;
  externalRef?: string;
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
  redactedScope?: RedactedScope;
}) {
  return {
    id: caseRecord.id,
    jurisdiction: caseRecord.jurisdiction,
    riskLevel: caseRecord.riskLevel,
    authorityBasis: caseRecord.authorityBasis,
    partnerId: caseRecord.partnerId,
    externalRef: caseRecord.externalRef,
    retentionDays: caseRecord.retentionDays,
    createdAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
    redactedScope: caseRecord.redactedScope ?? null
  };
}

function apiBaseFromRequest(request: IncomingMessage): string {
  const configured = process.env.OBLIVION_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = request.headers.host;
  return host ? `http://${host}` : "http://localhost:8080";
}

export async function emitApprovalPendingWebhook(
  store: MemoryStore,
  caseId: string,
  approval: {
    id: string;
    destination: string;
    dataToDisclose: IdentifierCategory[];
    expiresAt: string;
    actionType: string;
  }
): Promise<void> {
  await emitCaseWebhook(store, caseId, "approval.pending", {
    approvalId: approval.id,
    destination: approval.destination,
    dataToDisclose: approval.dataToDisclose,
    expiresAt: approval.expiresAt,
    actionType: approval.actionType
  });
}