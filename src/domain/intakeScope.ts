import { redactText } from "./redaction.js";
import type { RedactedScope } from "./types.js";

export interface ParsedIntakeFields {
  legalName?: string;
  email?: string;
  contactEmail?: string;
  cityState?: string;
  address?: string;
  relative?: string;
  aliases?: string[];
  sensitiveConstraints?: string[];
}

export function redactedScopeFromIntake(parsed: ParsedIntakeFields): RedactedScope {
  const labels: string[] = [];
  if (parsed.legalName) labels.push("legal-name");
  if (parsed.email || parsed.contactEmail) labels.push("email");
  if (parsed.cityState) labels.push("city-state");
  if (parsed.address) labels.push("address");
  if (parsed.relative) labels.push("relative");
  const personLabel = parsed.legalName
    ? `${String(parsed.legalName).trim().split(/\s+/).map((part) => part[0]).join(".")}.`
    : "User";
  return {
    personLabel: redactText(personLabel),
    aliases: (parsed.aliases ?? []).map(redactText),
    approvedIdentifierLabels: labels.length ? labels.map(redactText) : ["email"],
    sensitiveConstraints: (parsed.sensitiveConstraints ?? []).map(redactText)
  };
}