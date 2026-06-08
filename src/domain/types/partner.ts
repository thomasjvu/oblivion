export type PartnerEnvironment = "production" | "sandbox";

export interface PartnerRecord {
  id: string;
  name: string;
  apiKeyHash: string;
  environment: PartnerEnvironment;
  balanceCredits: number;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookEvents: PartnerWebhookEvent[];
  keyRotatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PartnerWebhookEvent =
  | "case.created"
  | "case.phase_changed"
  | "exposure.discovered"
  | "approval.pending"
  | "approval.approved"
  | "action.executed"
  | "recheck.due"
  | "case.completed"
  | "case.deleted";

export interface PartnerWebhookDelivery {
  id: string;
  partnerId: string;
  event: PartnerWebhookEvent;
  caseId?: string;
  status: "pending" | "delivered" | "failed";
  responseStatus?: number;
  error?: string;
  attemptCount: number;
  nextRetryAt?: string;
  body?: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface PartnerWebhookInboxEntry {
  id: string;
  partnerId: string;
  event: PartnerWebhookEvent;
  payload: Record<string, unknown>;
  signatureValid: boolean;
  receivedAt: string;
}

export type PartnerMeterKind = "case" | "discover" | "execute" | "ai";

export interface PartnerUsageEntry {
  id: string;
  partnerId: string;
  caseId?: string;
  kind: PartnerMeterKind;
  credits: number;
  invoiceId?: string;
  createdAt: string;
}

export interface PartnerInvoiceLine {
  kind: PartnerMeterKind;
  count: number;
  credits: number;
  rate: number;
}

export interface PartnerInvoice {
  id: string;
  partnerId: string;
  period: string;
  status: "open" | "closed";
  totalCredits: number;
  estimatedUsd: number;
  lineItems: PartnerInvoiceLine[];
  closedAt?: string;
  createdAt: string;
}

export type PartnerDataAccessAction = "export" | "delete";

export interface PartnerDataAccessEvent {
  id: string;
  partnerId: string;
  caseId: string;
  action: PartnerDataAccessAction;
  source: "v1" | "api";
  at: string;
}