import { isBrokerEmailConfigured, sendTransactionalEmail } from "./brokerMailer.js";
import { redactText } from "./redaction.js";
import { buildDraftText } from "./templates.js";
import type { ActionRequest, Approval } from "./types.js";

export interface HostAbuseContact {
  host: string;
  email: string;
  channel?: string;
  inferred: boolean;
}

const HOST_ABUSE_CONTACTS: Record<string, { email: string; channel?: string }> = {
  "reddit.com": { email: "abuse@reddit.com", channel: "https://www.reddit.com/report" },
  "twitter.com": { email: "abuse@twitter.com", channel: "https://help.twitter.com/forms/dmca" },
  "x.com": { email: "abuse@twitter.com", channel: "https://help.twitter.com/forms/dmca" },
  "facebook.com": { email: "ip@facebook.com", channel: "https://www.facebook.com/help/contact/571927396488898" },
  "instagram.com": { email: "ip@facebook.com" },
  "youtube.com": { email: "copyright@youtube.com", channel: "https://www.youtube.com/copyright_complaint_form" },
  "tiktok.com": { email: "legal@tiktok.com" },
  "github.com": { email: "abuse@github.com" },
  "wordpress.com": { email: "abuse@wordpress.com" },
  "medium.com": { email: "abuse@medium.com" },
  "tumblr.com": { email: "abuse@tumblr.com" },
  "pinterest.com": { email: "legal@pinterest.com" }
};

export function hostFromDestination(destination: string): string {
  const trimmed = destination.trim();
  if (!trimmed) return "";
  try {
    const url = trimmed.startsWith("http") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return trimmed.replace(/^www\./i, "").split("/")[0]?.toLowerCase() || "";
  }
}

export function resolveHostAbuseContact(destination: string, infringingUrl?: string): HostAbuseContact | undefined {
  const host = hostFromDestination(infringingUrl || destination);
  if (!host) return undefined;
  const known = HOST_ABUSE_CONTACTS[host];
  if (known) {
    return { host, email: known.email, channel: known.channel, inferred: false };
  }
  return { host, email: `abuse@${host}`, inferred: true };
}

export function isPlatformAbuseEmailConfigured(): boolean {
  return isBrokerEmailConfigured();
}

export async function sendPlatformAbuseNotice(input: {
  action: ActionRequest;
  approval: Approval;
  contact: HostAbuseContact;
  infringingUrl: string;
  emailLabel: string;
}): Promise<{ ok: boolean; provider?: "resend" | "smtp"; messageId?: string; error?: string }> {
  const draftText =
    input.action.draftText ||
    buildDraftText({
      actionType: input.action.actionType,
      jurisdiction: "US",
      destination: input.contact.host,
      purpose: input.approval.purpose
    });
  const subject = `Unauthorized content report — ${redactText(input.contact.host)}`;
  const body = [
    draftText,
    "",
    `Infringing URL: ${input.infringingUrl}`,
    `Host abuse contact: ${input.contact.email}`,
    input.contact.channel ? `Official channel: ${input.contact.channel}` : undefined,
    "",
    "Submitted through Oblivion after explicit user approval. Reply to the approved contact email only."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const mailed = await sendTransactionalEmail({
    to: input.contact.email,
    replyTo: input.emailLabel,
    subject,
    body
  });
  return mailed;
}