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

export interface RedactedScope {
  personLabel: string;
  aliases: string[];
  approvedIdentifierLabels: string[];
  sensitiveConstraints: string[];
}

export function redactedScopeFromIntake(parsed: ParsedIntakeFields): RedactedScope;