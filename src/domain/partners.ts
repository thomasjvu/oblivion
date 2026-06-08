import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PartnerEnvironment, PartnerRecord, PartnerWebhookEvent } from "./types.js";

const DEFAULT_EVENTS: PartnerWebhookEvent[] = [
  "case.created",
  "case.phase_changed",
  "exposure.discovered",
  "approval.pending",
  "approval.approved",
  "action.executed",
  "recheck.due",
  "case.completed",
  "case.deleted"
];

export function hashPartnerApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

function parsePartnerKeyEntries(
  raw: string | undefined,
  environment: PartnerEnvironment,
  defaultCredits: number
): PartnerRecord[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  const now = new Date().toISOString();
  return trimmed.split(",").map((entry) => {
    const [id, apiKey] = entry.split(":").map((part) => part.trim());
    if (!id || !apiKey) throw new Error("invalid-partner-keys-format");
    return {
      id,
      name: id,
      apiKeyHash: hashPartnerApiKey(apiKey),
      environment,
      balanceCredits: defaultCredits,
      webhookEvents: [...DEFAULT_EVENTS],
      createdAt: now,
      updatedAt: now
    };
  });
}

export function parsePartnerKeysFromEnv(value = process.env.OBLIVION_PARTNER_KEYS): PartnerRecord[] {
  const defaultCredits = Number(process.env.OBLIVION_PARTNER_DEFAULT_CREDITS || "1000");
  return parsePartnerKeyEntries(value, "production", defaultCredits);
}

export function parseSandboxPartnerKeysFromEnv(
  value = process.env.OBLIVION_PARTNER_SANDBOX_KEYS
): PartnerRecord[] {
  const defaultCredits = Number(process.env.OBLIVION_PARTNER_SANDBOX_CREDITS || "500");
  return parsePartnerKeyEntries(value, "sandbox", defaultCredits);
}

export function generatePartnerApiKey(environment: PartnerEnvironment = "production"): string {
  const prefix = environment === "sandbox" ? "obl_sandbox_" : "obl_live_";
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

export function rotatePartnerApiKey(partner: PartnerRecord): { partner: PartnerRecord; apiKey: string } {
  const apiKey = generatePartnerApiKey(partner.environment);
  const now = new Date().toISOString();
  return {
    apiKey,
    partner: {
      ...partner,
      apiKeyHash: hashPartnerApiKey(apiKey),
      keyRotatedAt: now,
      updatedAt: now
    }
  };
}

export function partnerFromAuthorization(
  authorization: string | undefined,
  partners: Map<string, PartnerRecord>
): PartnerRecord | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const apiKey = authorization.slice("Bearer ".length).trim();
  if (!apiKey) return undefined;
  const hash = hashPartnerApiKey(apiKey);
  return [...partners.values()].find((partner) => safeEqual(partner.apiKeyHash, hash));
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

export function partnerPresetAllowlist(): Set<string> {
  const raw = process.env.OBLIVION_PARTNER_PRESETS?.trim();
  if (!raw) return new Set(["people-search-cleanup", "breach-exposure"]);
  return new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
}