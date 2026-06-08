import { createHash, randomBytes } from "node:crypto";

export function generateCaseAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCaseAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyCaseAccessToken(token: string, hash: string | undefined): boolean {
  if (!hash) return false;
  return hashCaseAccessToken(token) === hash;
}