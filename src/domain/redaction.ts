import type { IdentifierCategory } from "./types.js";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export function redactText(input: string): string {
  return input
    .replace(EMAIL_RE, (value) => redactEmail(value))
    .replace(PHONE_RE, "[phone:redacted]")
    .replace(SSN_RE, "[ssn:blocked]")
    .replace(CARD_RE, "[payment:blocked]");
}

export function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[email:redacted]";
  const first = local.slice(0, 1);
  return `${first}${"*".repeat(Math.max(2, local.length - 1))}@${domain}`;
}

export function redactIdentifier(category: IdentifierCategory, value: string): string {
  if (category === "email") return redactEmail(value);
  if (category === "phone") return "[phone:redacted]";
  if (category === "address") return "[address:redacted]";
  if (category === "date-of-birth") return "[dob:redacted]";
  if (category === "government-id") return "[government-id:blocked]";
  if (category === "ssn") return "[ssn:blocked]";
  if (category === "password") return "[password:blocked]";
  if (category === "payment") return "[payment:blocked]";
  return redactText(value);
}

export function detectForbiddenSecrets(input: string): string[] {
  const findings: string[] = [];
  if (SSN_RE.test(input)) findings.push("full-ssn");
  SSN_RE.lastIndex = 0;
  if (CARD_RE.test(input)) findings.push("payment-card");
  CARD_RE.lastIndex = 0;
  return findings;
}
