import type { CaseRecord } from "../domain/types.js";

export class CaseStoreMap extends Map<string, CaseRecord> {
  private readonly idsByPartner = new Map<string, Set<string>>();

  private indexPartner(caseRecord: CaseRecord): void {
    if (!caseRecord.partnerId || caseRecord.deletedAt) return;
    let ids = this.idsByPartner.get(caseRecord.partnerId);
    if (!ids) {
      ids = new Set();
      this.idsByPartner.set(caseRecord.partnerId, ids);
    }
    ids.add(caseRecord.id);
  }

  private unindexPartner(caseRecord: CaseRecord): void {
    if (!caseRecord.partnerId) return;
    const ids = this.idsByPartner.get(caseRecord.partnerId);
    if (!ids) return;
    ids.delete(caseRecord.id);
    if (ids.size === 0) this.idsByPartner.delete(caseRecord.partnerId);
  }

  set(key: string, value: CaseRecord): this {
    const previous = this.get(key);
    if (previous) this.unindexPartner(previous);
    super.set(key, value);
    this.indexPartner(value);
    return this;
  }

  delete(key: string): boolean {
    const previous = this.get(key);
    const deleted = super.delete(key);
    if (previous) this.unindexPartner(previous);
    return deleted;
  }

  clear(): void {
    super.clear();
    this.idsByPartner.clear();
  }

  valuesForPartner(partnerId: string): CaseRecord[] {
    const ids = this.idsByPartner.get(partnerId);
    if (!ids) return [];
    const results: CaseRecord[] = [];
    for (const id of ids) {
      const caseRecord = this.get(id);
      if (caseRecord && !caseRecord.deletedAt) results.push(caseRecord);
    }
    return results;
  }
}