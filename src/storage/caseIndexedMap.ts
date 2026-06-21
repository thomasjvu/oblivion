export type CaseScopedRecord = { id: string; caseId: string };

export class CaseIndexedMap<T extends CaseScopedRecord> extends Map<string, T> {
  private readonly idsByCase = new Map<string, Set<string>>();

  private indexRecord(record: T): void {
    let ids = this.idsByCase.get(record.caseId);
    if (!ids) {
      ids = new Set();
      this.idsByCase.set(record.caseId, ids);
    }
    ids.add(record.id);
  }

  private unindexRecord(record: T): void {
    const ids = this.idsByCase.get(record.caseId);
    if (!ids) return;
    ids.delete(record.id);
    if (ids.size === 0) this.idsByCase.delete(record.caseId);
  }

  set(key: string, value: T): this {
    const previous = this.get(key);
    if (previous && previous.caseId !== value.caseId) {
      this.unindexRecord(previous);
    }
    super.set(key, value);
    this.indexRecord(value);
    return this;
  }

  delete(key: string): boolean {
    const previous = this.get(key);
    const deleted = super.delete(key);
    if (previous) this.unindexRecord(previous);
    return deleted;
  }

  clear(): void {
    super.clear();
    this.idsByCase.clear();
  }

  valuesForCase(caseId: string): T[] {
    const ids = this.idsByCase.get(caseId);
    if (!ids) return [];
    const results: T[] = [];
    for (const id of ids) {
      const item = this.get(id);
      if (item) results.push(item);
    }
    return results;
  }
}