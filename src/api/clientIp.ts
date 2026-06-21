import type { IncomingMessage } from "node:http";

/** When true, `X-Forwarded-For` is trusted for client IP (set behind a reverse proxy). */
export function trustProxyHeaders(): boolean {
  return process.env.OBLIVION_TRUST_PROXY === "true";
}

function forwardedClientIp(request: IncomingMessage): string | undefined {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || undefined;
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]?.trim() || undefined;
  }
  return undefined;
}

export function clientIp(request: IncomingMessage): string {
  if (trustProxyHeaders()) {
    return forwardedClientIp(request) || request.socket.remoteAddress || "unknown";
  }
  return request.socket.remoteAddress || "unknown";
}