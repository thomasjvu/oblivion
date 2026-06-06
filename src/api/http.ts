import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_JSON_BYTES = 64 * 1024;

export async function readJson<T>(request: IncomingMessage): Promise<T> {
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
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Object.assign(new Error("invalid-json"), { statusCode: 400 });
  }
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

export function sendText(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain"): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
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
    ...securityHeaders(),
    "content-type": contentType,
    "cache-control": cacheControl
  });
  response.end(body);
}

export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };
}
