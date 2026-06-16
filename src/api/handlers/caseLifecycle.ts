import { buildCaseExportBundle } from "../../domain/exportPrivacy.js";
import { purgeCaseData } from "../../domain/purgeCase.js";
import { recordPartnerDataAccess } from "../../domain/partnerAudit.js";
import { emitCaseDeletedWebhook } from "../../domain/webhooks.js";
import type { CaseRecord, PartnerRecord } from "../../domain/types.js";
import type { MemoryStore } from "../../storage/memoryStore.js";

export async function deleteCaseRecord(
  store: MemoryStore,
  caseRecord: CaseRecord,
  options: { partner?: PartnerRecord; emitWebhook?: boolean; auditSource?: "api" | "v1" } = {}
): Promise<{ caseId: string; deletedAt: string; tombstone: true }> {
  if (options.partner) {
    recordPartnerDataAccess(store, {
      partnerId: options.partner.id,
      caseId: caseRecord.id,
      action: "delete",
      source: options.auditSource ?? "v1"
    });
  }
  if (options.emitWebhook !== false) {
    await emitCaseDeletedWebhook(store, caseRecord.id);
  }
  const deletedAt = new Date().toISOString();
  caseRecord.deletedAt = deletedAt;
  caseRecord.encryptedIntake = undefined;
  caseRecord.encryptedVaultPointer = "deleted";
  purgeCaseData(store, caseRecord.id);
  store.tombstones.set(caseRecord.id, deletedAt);
  store.cases.set(caseRecord.id, caseRecord);
  return { caseId: caseRecord.id, deletedAt, tombstone: true };
}

export function exportCaseBundle(store: MemoryStore, caseRecord: CaseRecord) {
  return buildCaseExportBundle(store, caseRecord, "consumer");
}