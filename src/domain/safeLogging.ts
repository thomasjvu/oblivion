import { redactText } from "./redaction.js";

const SENSITIVE_KEYS = new Set([
  "ciphertext",
  "nonce",
  "rawKeyBase64",
  "encryptedValue",
  "encryptedIntake",
  "plaintextPreview",
  "userConfirmation",
  "draftText"
]);

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeForLog(child);
    }
  }
  return output;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(sanitizeForLog(value));
}
