import { redactText } from "./redaction.js";
import type {
  AuthorityBasis,
  CaseRecord,
  EncryptedBlob,
  Jurisdiction,
  RedactedScope,
  RiskLevel
} from "./types.js";

export interface CreateCaseInput {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  retentionDays?: number;
  casePreferences?: {
    operatorEmailRelay?: boolean;
  };
  partnerId?: string;
  externalRef?: string;
  callbackUrl?: string;
}

export function createCaseRecord(body: CreateCaseInput): CaseRecord {
  if (!["US", "EU", "UK"].includes(body.jurisdiction)) {
    throw Object.assign(new Error("unsupported-jurisdiction"), { statusCode: 422 });
  }
  if (!body.authorityBasis) {
    throw Object.assign(new Error("authority-basis-required"), { statusCode: 422 });
  }
  const now = new Date().toISOString();
  const id = `case_${crypto.randomUUID()}`;
  return {
    id,
    jurisdiction: body.jurisdiction,
    riskLevel: body.riskLevel ?? "standard",
    authorityBasis: body.authorityBasis,
    encryptedVaultPointer: `vault://${id}`,
    retentionDays: body.retentionDays ?? 90,
    casePreferences: {
      operatorEmailRelay: body.casePreferences?.operatorEmailRelay !== false
    },
    partnerId: body.partnerId,
    externalRef: body.externalRef?.trim() || undefined,
    callbackUrl: body.callbackUrl?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  };
}

export function validateEncryptedBlob(blob: EncryptedBlob): void {
  if (!blob || blob.alg !== "AES-256-GCM" || !blob.keyId || !blob.nonce || !blob.ciphertext) {
    throw Object.assign(new Error("valid-encrypted-intake-required"), { statusCode: 422 });
  }
}

export function sanitizeScope(scope: RedactedScope): RedactedScope {
  return {
    personLabel: redactText(scope.personLabel ?? "User"),
    aliases: (scope.aliases ?? []).map(redactText),
    approvedIdentifierLabels: (scope.approvedIdentifierLabels ?? []).map(redactText),
    sensitiveConstraints: (scope.sensitiveConstraints ?? []).map(redactText)
  };
}