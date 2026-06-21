import { DomainError } from "./errors.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog"
]);

const MAX_OUTBOUND_REDIRECTS = 3;

function ipv4FromMappedIpv6(host: string): string | null {
  const mappedPrefix = "::ffff:";
  if (!host.startsWith(mappedPrefix)) return null;
  const remainder = host.slice(mappedPrefix.length);
  if (remainder.includes(".")) return remainder;
  const parts = remainder.split(":").filter(Boolean);
  if (parts.length !== 2) return null;
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const mappedIpv4 = ipv4FromMappedIpv6(host);
  if (mappedIpv4) return mappedIpv4;
  const mappedPrefix = "::ffff:";
  if (host.startsWith(mappedPrefix)) {
    host = host.slice(mappedPrefix.length);
  }
  return host;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  if (host.endsWith(".localhost")) return true;
  if (isPrivateIpv4(host)) return true;
  return false;
}

export function isPartnerInboxDeliveryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/v1\/partners\/[^/]+\/webhook-inbox$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function assertSafeOutboundHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError("outbound-url-invalid", 422);
  }
  if (parsed.protocol !== "https:") {
    throw new DomainError("outbound-url-https-required", 422);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new DomainError("outbound-url-blocked", 422);
  }
}

export function isSafeOutboundHttpsUrl(url: string): boolean {
  try {
    assertSafeOutboundHttpsUrl(url);
    return true;
  } catch {
    return false;
  }
}

export async function safeOutboundFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isPartnerInboxDeliveryUrl(url)) {
    return fetch(url, { ...init, redirect: "follow" });
  }

  let current = url;
  for (let hop = 0; hop <= MAX_OUTBOUND_REDIRECTS; hop += 1) {
    assertSafeOutboundHttpsUrl(current);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current).href;
  }
  throw new DomainError("outbound-url-too-many-redirects", 422);
}