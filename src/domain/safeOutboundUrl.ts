import { DomainError } from "./errors.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog"
]);

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
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  if (host.endsWith(".localhost")) return true;
  if (isPrivateIpv4(host)) return true;
  return false;
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