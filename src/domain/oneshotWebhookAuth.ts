import { createHmac, timingSafeEqual } from "node:crypto";
import { deploymentEnvironment } from "./deploymentEnv.js";
import { isOneShotConfigured } from "./integrations.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export function resolveOneShotWebhookSession(
  store: MemoryStore,
  caseId: string,
  sessionId: string | undefined,
  token: string | undefined
) {
  if (!token) return null;
  const sessions = store.paymentSessionsForCase(caseId);
  const session = sessionId
    ? store.paymentSessions.get(sessionId)
    : sessions.find((item) => item.oneShotWebhookToken === token);
  if (!session || session.caseId !== caseId || session.oneShotWebhookToken !== token) {
    return null;
  }
  return session;
}

export function verifyOneShotWebhookSignature(payloadSignature: string | undefined): boolean {
  const secret = process.env.ONESHOT_WEBHOOK_SECRET?.trim() || process.env.ONESHOT_API_KEY?.trim();
  if (!secret) {
    return deploymentEnvironment() !== "production" || !isOneShotConfigured();
  }
  if (!payloadSignature) return false;
  const left = Buffer.from(secret);
  const right = Buffer.from(payloadSignature);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signOneShotWebhookProbe(body: string): string {
  const secret = process.env.ONESHOT_WEBHOOK_SECRET?.trim() || process.env.ONESHOT_API_KEY?.trim();
  if (!secret) return "";
  return createHmac("sha256", secret).update(body).digest("hex");
}