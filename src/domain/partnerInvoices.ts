import { CREDITS_PER_USD } from "./credits.js";
import { DomainError } from "./errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { PARTNER_METER_RATES } from "./partnerBilling.js";
import type { PartnerInvoice, PartnerInvoiceLine, PartnerMeterKind, PartnerRecord } from "./types.js";

const PERIOD_RE = /^\d{4}-\d{2}$/;

export function normalizeInvoicePeriod(period: string): string {
  const trimmed = period.trim();
  if (!PERIOD_RE.test(trimmed)) {
    throw new DomainError("invalid-invoice-period", 422);
  }
  return trimmed;
}

function usageInPeriod(store: MemoryStore, partnerId: string, period: string) {
  return [...store.partnerUsage.values()].filter(
    (entry) =>
      entry.partnerId === partnerId &&
      !entry.invoiceId &&
      entry.createdAt.slice(0, 7) === period
  );
}

function buildLineItems(entries: ReturnType<typeof usageInPeriod>): PartnerInvoiceLine[] {
  const grouped = entries.reduce<Record<PartnerMeterKind, { count: number; credits: number }>>(
    (acc, entry) => {
      const bucket = acc[entry.kind] ?? { count: 0, credits: 0 };
      bucket.count += 1;
      bucket.credits += entry.credits;
      acc[entry.kind] = bucket;
      return acc;
    },
    {} as Record<PartnerMeterKind, { count: number; credits: number }>
  );
  return Object.entries(grouped).map(([kind, stats]) => ({
    kind: kind as PartnerMeterKind,
    count: stats.count,
    credits: stats.credits,
    rate: PARTNER_METER_RATES[kind as PartnerMeterKind]
  }));
}

export function listPartnerInvoices(store: MemoryStore, partnerId: string) {
  return [...store.partnerInvoices.values()]
    .filter((invoice) => invoice.partnerId === partnerId)
    .sort((a, b) => b.period.localeCompare(a.period));
}

export function getPartnerInvoice(store: MemoryStore, partnerId: string, invoiceId: string) {
  const invoice = store.partnerInvoices.get(invoiceId);
  if (!invoice || invoice.partnerId !== partnerId) {
    throw new DomainError("invoice-not-found", 404);
  }
  return invoice;
}

export function closePartnerInvoicePeriod(
  store: MemoryStore,
  partner: PartnerRecord,
  periodInput: string
): PartnerInvoice {
  const period = normalizeInvoicePeriod(periodInput);
  const existing = listPartnerInvoices(store, partner.id).find(
    (invoice) => invoice.period === period && invoice.status === "closed"
  );
  if (existing) return existing;

  const entries = usageInPeriod(store, partner.id, period);
  const lineItems = buildLineItems(entries);
  const totalCredits = lineItems.reduce((sum, line) => sum + line.credits, 0);
  const now = new Date().toISOString();
  const invoice: PartnerInvoice = {
    id: `inv_${crypto.randomUUID()}`,
    partnerId: partner.id,
    period,
    status: "closed",
    totalCredits,
    estimatedUsd: Number((totalCredits / CREDITS_PER_USD).toFixed(2)),
    lineItems,
    closedAt: now,
    createdAt: now
  };
  store.partnerInvoices.set(invoice.id, invoice);
  for (const entry of entries) {
    entry.invoiceId = invoice.id;
    store.partnerUsage.set(entry.id, entry);
  }
  return invoice;
}

export function invoiceView(invoice: PartnerInvoice) {
  return {
    id: invoice.id,
    partnerId: invoice.partnerId,
    period: invoice.period,
    status: invoice.status,
    totalCredits: invoice.totalCredits,
    estimatedUsd: invoice.estimatedUsd,
    lineItems: invoice.lineItems,
    closedAt: invoice.closedAt,
    createdAt: invoice.createdAt
  };
}