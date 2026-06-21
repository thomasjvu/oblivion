import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "./errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { buildStatus } from "./status.js";
import { sanitizeForLog } from "./safeLogging.js";
import type {
  CaseRecord,
  FollowUp,
  IdentifierCategory,
  PartnerRecord,
  PartnerWebhookDelivery,
  PartnerWebhookEvent,
  PartnerWebhookInboxEntry
} from "./types.js";

export const WEBHOOK_MAX_RETRIES = Number(process.env.OBLIVION_WEBHOOK_MAX_RETRIES || "5");
export const WEBHOOK_RETRY_BASE_MS = Number(process.env.OBLIVION_WEBHOOK_RETRY_BASE_MS || "60000");
export const WEBHOOK_RETRY_ENABLED = process.env.OBLIVION_WEBHOOK_RETRY_ENABLED !== "false";

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  maxAgeSeconds = 300
): boolean {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > maxAgeSeconds) return false;
  const expected = signWebhookPayload(secret, timestamp, body);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function storeWebhookInboxEntry(
  store: MemoryStore,
  partnerId: string,
  event: PartnerWebhookEvent,
  payload: Record<string, unknown>,
  signatureValid: boolean
): PartnerWebhookInboxEntry {
  const entry: PartnerWebhookInboxEntry = {
    id: `inbox_${crypto.randomUUID()}`,
    partnerId,
    event,
    payload,
    signatureValid,
    receivedAt: new Date().toISOString()
  };
  store.partnerWebhookInbox.set(entry.id, entry);
  return entry;
}

export function partnerWebhookInboxUrl(partnerId: string, apiBase: string): string {
  const base = apiBase.replace(/\/$/, "");
  return `${base}/v1/partners/${partnerId}/webhook-inbox`;
}

function buildWebhookBody(
  partner: PartnerRecord,
  event: PartnerWebhookEvent,
  payload: Record<string, unknown>,
  createdAt: string
): string {
  return JSON.stringify({
    event,
    partnerId: partner.id,
    createdAt,
    data: payload
  });
}

export function scheduleNextRetry(attemptCount: number): string | undefined {
  if (!WEBHOOK_RETRY_ENABLED || attemptCount >= WEBHOOK_MAX_RETRIES) return undefined;
  const delayMs = WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
  return new Date(Date.now() + delayMs).toISOString();
}

async function postSignedWebhook(
  url: string,
  secret: string,
  event: PartnerWebhookEvent,
  body: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(secret, timestamp, body);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oblivion-event": event,
        "x-oblivion-timestamp": timestamp,
        "x-oblivion-signature": signature
      },
      body
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `http-${response.status}` };
  } catch (error) {
    return { ok: false, error: String(sanitizeForLog(error)) };
  }
}

async function postWebhook(
  partner: PartnerRecord,
  event: PartnerWebhookEvent,
  body: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!partner.webhookUrl) return { ok: false, error: "webhook-url-missing" };
  const secret = partner.webhookSecret;
  if (!secret || secret === partner.id) {
    return { ok: false, error: "webhook-secret-missing" };
  }
  return postSignedWebhook(partner.webhookUrl, secret, event, body);
}

export async function dispatchCaseCallbackWebhook(
  caseRecord: CaseRecord,
  partner: PartnerRecord | undefined,
  event: PartnerWebhookEvent,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; error?: string } | undefined> {
  const callbackUrl = caseRecord.callbackUrl?.trim();
  if (!callbackUrl?.startsWith("https://")) return undefined;
  const partnerWebhookUrl = partner?.webhookUrl?.trim();
  if (partnerWebhookUrl && callbackUrl === partnerWebhookUrl) return undefined;
  const secret = partner?.webhookSecret;
  if (!secret || secret === partner?.id) {
    return { ok: false, error: "webhook-secret-missing" };
  }
  const createdAt = new Date().toISOString();
  const body = JSON.stringify({
    event,
    caseId: caseRecord.id,
    partnerId: caseRecord.partnerId,
    externalRef: caseRecord.externalRef,
    createdAt,
    data: payload
  });
  return postSignedWebhook(callbackUrl, secret, event, body);
}

async function deliverWebhook(
  store: MemoryStore,
  partner: PartnerRecord,
  delivery: PartnerWebhookDelivery
): Promise<PartnerWebhookDelivery> {
  if (!delivery.body) {
    delivery.status = "failed";
    delivery.error = "webhook-body-missing";
    delivery.deliveredAt = new Date().toISOString();
    store.webhookDeliveries.set(delivery.id, delivery);
    return delivery;
  }
  delivery.attemptCount = (delivery.attemptCount || 0) + 1;
  const result = await postWebhook(partner, delivery.event, delivery.body);
  delivery.deliveredAt = new Date().toISOString();
  delivery.responseStatus = result.status;
  if (result.ok) {
    delivery.status = "delivered";
    delivery.error = undefined;
    delivery.nextRetryAt = undefined;
  } else {
    delivery.status = "failed";
    delivery.error = result.error;
    delivery.nextRetryAt = scheduleNextRetry(delivery.attemptCount);
  }
  store.webhookDeliveries.set(delivery.id, delivery);
  return delivery;
}

export async function dispatchPartnerWebhook(
  store: MemoryStore,
  partner: PartnerRecord,
  event: PartnerWebhookEvent,
  payload: Record<string, unknown>
): Promise<PartnerWebhookDelivery | undefined> {
  if (!partner.webhookUrl || !partner.webhookEvents.includes(event)) return undefined;
  const createdAt = new Date().toISOString();
  const body = buildWebhookBody(partner, event, payload, createdAt);
  const delivery: PartnerWebhookDelivery = {
    id: `wh_${crypto.randomUUID()}`,
    partnerId: partner.id,
    event,
    caseId: typeof payload.caseId === "string" ? payload.caseId : undefined,
    status: "pending",
    attemptCount: 0,
    body,
    createdAt
  };
  store.webhookDeliveries.set(delivery.id, delivery);
  return deliverWebhook(store, partner, delivery);
}

export async function retryWebhookDelivery(
  store: MemoryStore,
  partner: PartnerRecord,
  deliveryId: string
): Promise<PartnerWebhookDelivery> {
  const delivery = store.webhookDeliveries.get(deliveryId);
  if (!delivery || delivery.partnerId !== partner.id) {
    throw new DomainError("webhook-delivery-not-found", 404);
  }
  if (delivery.status === "delivered") {
    throw new DomainError("webhook-already-delivered", 409);
  }
  if ((delivery.attemptCount || 0) >= WEBHOOK_MAX_RETRIES) {
    throw new DomainError("webhook-max-retries-exceeded", 409);
  }
  delivery.status = "pending";
  delivery.nextRetryAt = undefined;
  return deliverWebhook(store, partner, delivery);
}

export async function retryFailedWebhookDeliveries(
  store: MemoryStore,
  partner: PartnerRecord,
  limit = 10
): Promise<PartnerWebhookDelivery[]> {
  const due = [...store.webhookDeliveries.values()]
    .filter((delivery) => delivery.partnerId === partner.id)
    .filter((delivery) => delivery.status === "failed")
    .filter((delivery) => (delivery.attemptCount || 0) < WEBHOOK_MAX_RETRIES)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
  const results: PartnerWebhookDelivery[] = [];
  for (const delivery of due) {
    results.push(await deliverWebhook(store, partner, delivery));
  }
  return results;
}

export async function processDueWebhookRetries(store: MemoryStore): Promise<number> {
  if (!WEBHOOK_RETRY_ENABLED) return 0;
  const now = Date.now();
  const due = [...store.webhookDeliveries.values()].filter(
    (delivery) =>
      delivery.status === "failed" &&
      delivery.nextRetryAt &&
      Date.parse(delivery.nextRetryAt) <= now &&
      (delivery.attemptCount || 0) < WEBHOOK_MAX_RETRIES
  );
  let processed = 0;
  for (const delivery of due) {
    const partner = store.partners.get(delivery.partnerId);
    if (!partner) continue;
    await deliverWebhook(store, partner, delivery);
    processed += 1;
  }
  return processed;
}

export function partnerForCase(store: MemoryStore, caseId: string): PartnerRecord | undefined {
  const caseRecord = store.cases.get(caseId);
  if (!caseRecord?.partnerId) return undefined;
  return store.partners.get(caseRecord.partnerId);
}

export async function emitCaseWebhook(
  store: MemoryStore,
  caseId: string,
  event: PartnerWebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const caseRecord = store.cases.get(caseId);
  if (!caseRecord) return;
  const partner = partnerForCase(store, caseId);
  const fullPayload = { caseId, ...payload };
  if (partner) {
    await dispatchPartnerWebhook(store, partner, event, fullPayload);
  }
  await dispatchCaseCallbackWebhook(caseRecord, partner, event, fullPayload);
}

export async function emitRecheckScheduledWebhooks(
  store: MemoryStore,
  caseId: string,
  followUps: FollowUp[]
): Promise<void> {
  const partner = partnerForCase(store, caseId);
  if (!partner) return;
  for (const followUp of followUps) {
    await dispatchPartnerWebhook(store, partner, "recheck.due", {
      caseId,
      dueDate: followUp.dueDate,
      brokerId: followUp.brokerId,
      brokerLabel: followUp.brokerLabel,
      exposureId: followUp.exposureId,
      expectedResponseWindow: followUp.expectedResponseWindow,
      kind: "scheduled"
    });
  }
}

export async function emitCaseCompletedWebhook(
  store: MemoryStore,
  caseId: string,
  previousStep?: string,
  currentStep?: string
): Promise<void> {
  if (!currentStep || currentStep !== "complete" || previousStep === "complete") return;
  const status = buildStatus(store, caseId);
  await emitCaseWebhook(store, caseId, "case.completed", {
    removalsComplete: status.submittedActions.length,
    pendingApprovals: status.approvalsNeeded.length,
    phase: currentStep
  });
}

export async function emitCaseDeletedWebhook(store: MemoryStore, caseId: string): Promise<void> {
  await emitCaseWebhook(store, caseId, "case.deleted", { deletedAt: new Date().toISOString() });
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

export async function notifyCasePendingApprovals(store: MemoryStore, caseId: string): Promise<void> {
  const status = buildStatus(store, caseId);
  for (const approval of status.approvalsNeeded) {
    await emitCaseWebhook(store, caseId, "approval.pending", {
      approvalId: approval.id,
      destination: approval.destination,
      dataToDisclose: approval.dataToDisclose,
      expiresAt: approval.expiresAt,
      actionType: approval.actionType
    });
  }
}