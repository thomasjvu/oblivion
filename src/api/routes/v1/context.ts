import type { IncomingMessage } from "node:http";
import type { TrustCenterConfig } from "../../../domain/attestation.js";
import type {
  AuthorityBasis,
  Jurisdiction,
  PartnerRecord,
  PartnerWebhookEvent,
  RedactedScope,
  RiskLevel
} from "../../../domain/types.js";
import type { MemoryStore } from "../../../storage/memoryStore.js";

export interface V1Context {
  store: MemoryStore;
  trustCenterPath: string;
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>;
}

export interface V1PartnerContext extends V1Context {
  partner: PartnerRecord;
}

export interface CreateV1CaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  externalRef?: string;
  callbackUrl?: string;
  retentionDays?: number;
}

export interface WebhookBody {
  url: string;
  secret?: string;
  events?: string[];
}

export function summarizePartnerCase(caseRecord: {
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

export function apiBaseFromRequest(request: IncomingMessage): string {
  const configured = process.env.OBLIVION_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = request.headers.host;
  return host ? `http://${host}` : "http://localhost:8080";
}

export type { PartnerWebhookEvent };