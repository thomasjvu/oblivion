import { buildDraftText } from "./templates.js";
import type { ActionRequest, Approval } from "./types.js";

export interface EmailHandoffInput {
  action: ActionRequest;
  approval: Approval;
  to: string;
  replyTo?: string;
  subject?: string;
}

export function buildEmailHandoff(input: EmailHandoffInput): { mailtoUrl: string; draftText: string } {
  const draftText =
    input.action.draftText ||
    buildDraftText({
      actionType: input.action.actionType,
      jurisdiction: "US",
      destination: input.action.destination,
      purpose: input.approval.purpose
    });
  const subject =
    input.subject ||
    (input.action.actionType === "platform-abuse-report"
      ? `Abuse report: ${input.action.destination}`
      : `Opt-out request: ${input.action.destination}`);
  const body = draftText.slice(0, 1800);
  const params = new URLSearchParams();
  params.set("subject", subject);
  params.set("body", body);
  if (input.replyTo) params.set("reply-to", input.replyTo);
  const mailtoUrl = `mailto:${encodeURIComponent(input.to)}?${params.toString()}`;
  return { mailtoUrl, draftText };
}

export function operatorEmailRelayEnabled(): boolean {
  return process.env.OBLIVION_OPERATOR_EMAIL_RELAY !== "false";
}