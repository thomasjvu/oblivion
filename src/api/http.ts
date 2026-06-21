import type { IncomingMessage, ServerResponse } from "node:http";
import { corsAllowedOrigin } from "../domain/integrations.js";

const MAX_JSON_BYTES = 64 * 1024;
let currentRequestOrigin: string | undefined;

export function bindRequestOrigin(origin: string | undefined): void {
  currentRequestOrigin = origin;
}

export function clearRequestOrigin(): void {
  currentRequestOrigin = undefined;
}

async function readBodyBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw Object.assign(new Error("request-body-too-large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readRawBody(request: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(request)).toString("utf8");
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRawBody(request);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Object.assign(new Error("invalid-json"), { statusCode: 400 });
  }
}

function resolveCorsOrigin(requestOrigin?: string): string | undefined {
  const allowed = corsAllowedOrigin();
  if (!allowed) return undefined;
  if (allowed === "*") return requestOrigin || "*";
  if (requestOrigin && requestOrigin === allowed) return requestOrigin;
  return undefined;
}

export function corsHeaders(requestOrigin?: string): Record<string, string> {
  const origin = resolveCorsOrigin(requestOrigin);
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, payment-signature, idempotency-key",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

export function securityHeaders(requestOrigin?: string): Record<string, string> {
  const connectSrc = ["'self'"];
  const allowed = corsAllowedOrigin();
  if (allowed && allowed !== "*") connectSrc.push(allowed);
  const apiOrigin = process.env.OBLIVION_PUBLIC_API_URL?.trim().replace(/\/$/, "");
  if (apiOrigin) connectSrc.push(apiOrigin);
  return {
    ...corsHeaders(requestOrigin),
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "media-src 'self'",
      `connect-src ${connectSrc.join(" ")}`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    ...securityHeaders(currentRequestOrigin),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

export function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain"
): void {
  response.writeHead(statusCode, {
    ...securityHeaders(currentRequestOrigin),
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store"
  });
  response.end(body);
}

export function sendBytes(
  response: ServerResponse,
  statusCode: number,
  body: Buffer,
  contentType: string,
  cacheControl = "public, max-age=86400"
): void {
  response.writeHead(statusCode, {
    ...securityHeaders(currentRequestOrigin),
    "content-type": contentType,
    "cache-control": cacheControl
  });
  response.end(body);
}