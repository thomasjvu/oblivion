import { connect as tlsConnect } from "node:tls";
import { envString } from "./integrations.js";
import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";

export function isResendConfigured(): boolean {
  return Boolean(envString("RESEND_API_KEY"));
}

export function isSmtpConfigured(): boolean {
  return Boolean(envString("SMTP_HOST") && envString("SMTP_FROM"));
}

export function isBrokerEmailConfigured(): boolean {
  return isResendConfigured() || isSmtpConfigured();
}

export function brokerEmailFrom(): string {
  return envString("SMTP_FROM", "privacy-agent@oblivion.local");
}

export interface BrokerOptOutEmailInput {
  brokerLabel: string;
  to: string;
  replyTo?: string;
  profileUrl?: string;
  purpose: string;
}

export interface BrokerOptOutEmailResult {
  ok: boolean;
  provider: "resend" | "smtp";
  messageId?: string;
  error?: string;
}

export async function sendTransactionalEmail(input: {
  to: string;
  replyTo?: string;
  subject: string;
  body: string;
}): Promise<BrokerOptOutEmailResult> {
  if (isResendConfigured()) {
    return sendViaResend(input);
  }
  if (isSmtpConfigured()) {
    return sendViaSmtp(input);
  }
  return { ok: false, provider: "smtp", error: "broker-email-not-configured" };
}

export async function sendBrokerOptOutEmail(input: BrokerOptOutEmailInput): Promise<BrokerOptOutEmailResult> {
  const subject = `Opt-out request — ${redactText(input.brokerLabel)}`;
  const lines = [
    "This is an approved people-search opt-out request submitted through Oblivion.",
    "",
    `Broker: ${redactText(input.brokerLabel)}`,
    input.profileUrl ? `Profile URL: ${input.profileUrl}` : undefined,
    input.replyTo ? `Reply-to contact: ${redactText(input.replyTo)}` : undefined,
    "",
    `Purpose: ${redactText(input.purpose)}`,
    "",
    "Only the minimum identifiers approved by the user were disclosed for this request."
  ].filter((line): line is string => Boolean(line));
  return sendTransactionalEmail({
    to: input.to,
    replyTo: input.replyTo,
    subject,
    body: lines.join("\n")
  });
}

async function sendViaResend(input: {
  to: string;
  replyTo?: string;
  subject: string;
  body: string;
}): Promise<BrokerOptOutEmailResult> {
  const apiKey = envString("RESEND_API_KEY");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: brokerEmailFrom(),
      to: [input.to],
      reply_to: input.replyTo,
      subject: input.subject,
      text: input.body
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      provider: "resend",
      error: `resend-http-${response.status}`,
      messageId: String(sanitizeForLog(raw.slice(0, 120)))
    };
  }
  let parsed: { id?: string };
  try {
    parsed = JSON.parse(raw) as { id?: string };
  } catch {
    return { ok: false, provider: "resend", error: "resend-invalid-json" };
  }
  return { ok: true, provider: "resend", messageId: parsed.id };
}

async function sendViaSmtp(input: {
  to: string;
  replyTo?: string;
  subject: string;
  body: string;
}): Promise<BrokerOptOutEmailResult> {
  const host = envString("SMTP_HOST");
  const port = Number(envString("SMTP_PORT", "465"));
  const user = envString("SMTP_USER");
  const pass = envString("SMTP_PASS");
  const from = brokerEmailFrom();

  try {
    await smtpSendTls({
      host,
      port,
      user,
      pass,
      from,
      to: input.to,
      replyTo: input.replyTo,
      subject: input.subject,
      body: input.body
    });
    return { ok: true, provider: "smtp", messageId: `smtp-${Date.now()}` };
  } catch (error) {
    return {
      ok: false,
      provider: "smtp",
      error: error instanceof Error ? error.message : "smtp-send-failed"
    };
  }
}

async function smtpSendTls(input: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  body: string;
}): Promise<void> {
  const socket = tlsConnect({ host: input.host, port: input.port, servername: input.host });
  const lines = collectSmtpLines(socket);
  await expectSmtpCode(lines, 220);
  await writeSmtp(socket, `EHLO oblivion.local`);
  await expectSmtpCode(lines, 250);
  if (input.user && input.pass) {
    await writeSmtp(socket, "AUTH LOGIN");
    await expectSmtpCode(lines, 334);
    await writeSmtp(socket, Buffer.from(input.user).toString("base64"));
    await expectSmtpCode(lines, 334);
    await writeSmtp(socket, Buffer.from(input.pass).toString("base64"));
    await expectSmtpCode(lines, 235);
  }
  await writeSmtp(socket, `MAIL FROM:<${input.from}>`);
  await expectSmtpCode(lines, 250);
  await writeSmtp(socket, `RCPT TO:<${input.to}>`);
  await expectSmtpCode(lines, 250);
  await writeSmtp(socket, "DATA");
  await expectSmtpCode(lines, 354);
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    input.replyTo ? `Reply-To: ${input.replyTo}` : undefined,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ]
    .filter(Boolean)
    .join("\r\n");
  await writeSmtp(socket, `${headers}\r\n\r\n${input.body}\r\n.`);
  await expectSmtpCode(lines, 250);
  await writeSmtp(socket, "QUIT");
  socket.end();
}

function collectSmtpLines(socket: NodeJS.ReadableStream): string[] {
  const lines: string[] = [];
  socket.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  });
  return lines;
}

async function expectSmtpCode(lines: string[], code: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = lines.find((line) => Number(line.slice(0, 3)) === code);
    if (match) {
      const index = lines.indexOf(match);
      lines.splice(0, index + 1);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`smtp-missing-${code}`);
}

function writeSmtp(socket: NodeJS.WritableStream, line: string): void {
  socket.write(`${line}\r\n`);
}