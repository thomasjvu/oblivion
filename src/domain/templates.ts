import type { ActionType, Jurisdiction } from "./types.js";

export function templateForAction(actionType: ActionType, jurisdiction: Jurisdiction): string {
  if (actionType === "gdpr-erasure") return "gdpr-uk-erasure-request.md";
  if (actionType === "uk-gdpr-erasure") return "gdpr-uk-erasure-request.md";
  if (actionType === "broker-opt-out") return "broker-opt-out-request.md";
  if (actionType === "search-result-removal") return "search-result-removal-note";
  if (actionType === "hibp-email-check") return "hibp-email-check-approval";
  if (actionType === "follow-up") return "follow-up-request.md";
  if (actionType === "escalation-draft") return "escalation-notes.md";
  if (jurisdiction === "EU" || jurisdiction === "UK") return "gdpr-uk-erasure-request.md";
  return "broker-opt-out-request.md";
}

export function buildDraftText(input: {
  actionType: ActionType;
  jurisdiction: Jurisdiction;
  destination: string;
  purpose: string;
}): string {
  const legalLimit =
    "This request is limited to the specific record or processing purpose identified by the user and does not assert rights beyond applicable law.";

  if (input.actionType === "gdpr-erasure" || input.actionType === "uk-gdpr-erasure") {
    return [
      `To: ${input.destination}`,
      "Subject: Request for erasure of personal data",
      "",
      "I am requesting erasure of personal data associated with the data subject, subject to applicable GDPR or UK GDPR rights and exemptions.",
      `Purpose: ${input.purpose}`,
      legalLimit
    ].join("\n");
  }

  if (input.actionType === "broker-opt-out") {
    return [
      `To: ${input.destination}`,
      "Subject: People-search opt-out request",
      "",
      "Please remove or suppress the identified people-search profile from public display.",
      `Purpose: ${input.purpose}`,
      "Only the minimum matching data approved by the user should be disclosed for verification."
    ].join("\n");
  }

  if (input.actionType === "hibp-email-check") {
    return "Approved email exposure check using Have I Been Pwned. Store only the checked source, date, and result category needed for mitigation.";
  }

  return [
    `Destination: ${input.destination}`,
    `Action: ${input.actionType}`,
    `Purpose: ${input.purpose}`,
    legalLimit
  ].join("\n");
}
