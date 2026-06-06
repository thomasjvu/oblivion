import type { ActionType, Jurisdiction } from "./types.js";

export function deadlineBasisFor(actionType: ActionType, jurisdiction: Jurisdiction): string {
  if (actionType === "gdpr-erasure") return "GDPR response window, verify current regulator guidance before submission";
  if (actionType === "uk-gdpr-erasure") return "UK GDPR response window, verify current ICO guidance before submission";
  if (jurisdiction === "US" && actionType === "broker-opt-out") {
    return "Direct broker opt-out response window varies by site and state law";
  }
  if (actionType === "search-result-removal") return "Search engine removal request status depends on platform eligibility review";
  if (actionType === "hibp-email-check") return "Breach mitigation check, not deletion";
  if (actionType === "dmca-takedown" || actionType === "platform-abuse-report") {
    return "Host or platform takedown response window varies; track counter-notice risk for DMCA";
  }
  return "Verify current official source before relying on deadlines";
}

export function followUpDate(daysFromNow: number, now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  return date.toISOString();
}
