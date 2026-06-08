const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function extractEmailFromText(text: string | undefined): string | undefined {
  if (!text || typeof text !== "string") return undefined;
  const match = text.match(EMAIL_RE);
  return match?.[0];
}

export interface ExecuteHandoffInput {
  action?: {
    actionType?: string;
    exposureId?: string;
    destination?: string;
    dataToDisclose?: string[];
  };
  status?: {
    confirmedFindings?: Array<{ id: string; sourceUrl?: string }>;
    pendingFindings?: Array<{ id: string; sourceUrl?: string }>;
    findings?: Array<{ id: string; sourceUrl?: string }>;
  };
  intakeText?: string;
  contactEmail?: string;
  hashPrefix?: string;
}

export function buildExecuteHandoff(input: ExecuteHandoffInput): {
  sourceUrl?: string;
  emailLabel?: string;
  hashPrefix?: string;
} {
  const handoff: { sourceUrl?: string; emailLabel?: string; hashPrefix?: string } = {};
  const findings = [
    ...(input.status?.confirmedFindings || []),
    ...(input.status?.pendingFindings || []),
    ...(input.status?.findings || [])
  ];
  if (input.action?.exposureId) {
    const finding = findings.find((item) => item.id === input.action?.exposureId);
    if (finding?.sourceUrl) handoff.sourceUrl = finding.sourceUrl;
  }
  if (!handoff.sourceUrl && input.action?.destination && /^https?:\/\//i.test(input.action.destination)) {
    handoff.sourceUrl = input.action.destination;
  }
  const disclose = input.action?.dataToDisclose || [];
  if (disclose.includes("email")) {
    const email = input.contactEmail || extractEmailFromText(input.intakeText);
    if (email) handoff.emailLabel = email;
  }
  if (input.hashPrefix && /^[A-Fa-f0-9]{5}$/.test(input.hashPrefix)) {
    handoff.hashPrefix = input.hashPrefix.toLowerCase();
  }
  return handoff;
}