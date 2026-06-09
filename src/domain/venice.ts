import { redactText } from "./redaction.js";
import { sanitizeForLog } from "./safeLogging.js";
import type { ActionType, VeniceAnalysis, VeniceAnalysisKind } from "./types.js";

const DEFAULT_BASE = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "zai-org-glm-5-1";

export function isVeniceConfigured(): boolean {
  return Boolean(process.env.VENICE_API_KEY?.trim());
}

export function veniceBaseUrl(): string {
  return (process.env.VENICE_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

export function veniceModel(): string {
  return process.env.VENICE_MODEL || DEFAULT_MODEL;
}

interface VeniceChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
  };
}

export interface VeniceChatResult {
  content: string;
  tokensUsed: number;
}

export interface VeniceWebSearchResult {
  title: string;
  url: string;
  content: string;
  date?: string;
}

interface VeniceWebSearchResponse {
  query?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    date?: string;
  }>;
}

export async function veniceWebSearch(
  query: string,
  options: { limit?: number; searchProvider?: "brave" | "google" } = {}
): Promise<VeniceWebSearchResult[]> {
  const apiKey = process.env.VENICE_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error("venice-not-configured"), { statusCode: 503 });
  }
  const response = await fetch(`${veniceBaseUrl()}/augment/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      limit: options.limit ?? 10,
      search_provider: options.searchProvider ?? "brave"
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`venice-search-${response.status}`), {
      statusCode: response.status === 401 ? 502 : 502,
      detail: sanitizeForLog(raw.slice(0, 240))
    });
  }
  let parsed: VeniceWebSearchResponse;
  try {
    parsed = JSON.parse(raw) as VeniceWebSearchResponse;
  } catch {
    throw Object.assign(new Error("venice-search-invalid-json"), { statusCode: 502 });
  }
  const results = parsed.results ?? [];
  return results
    .map((item) => ({
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      content: typeof item.content === "string" ? item.content : "",
      date: typeof item.date === "string" ? item.date : undefined
    }))
    .filter((item) => item.url.trim().length > 0);
}

export async function veniceChatCompletion(
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: { maxTokens?: number } = {}
): Promise<VeniceChatResult> {
  const apiKey = process.env.VENICE_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error("venice-not-configured"), { statusCode: 503 });
  }
  const response = await fetch(`${veniceBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: veniceModel(),
      temperature: 0.2,
      max_completion_tokens: options.maxTokens ?? 1200,
      messages
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`venice-http-${response.status}`), {
      statusCode: response.status === 401 ? 502 : 502,
      detail: sanitizeForLog(raw.slice(0, 240))
    });
  }
  let parsed: VeniceChatResponse;
  try {
    parsed = JSON.parse(raw) as VeniceChatResponse;
  } catch {
    throw Object.assign(new Error("venice-invalid-json"), { statusCode: 502 });
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw Object.assign(new Error("venice-empty-response"), { statusCode: 502 });
  }
  const maxCompletion = options.maxTokens ?? 1200;
  const tokensUsed =
    parsed.usage?.total_tokens ??
    parsed.usage?.completion_tokens ??
    Math.ceil(maxCompletion / 2);
  return { content, tokensUsed };
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw Object.assign(new Error("venice-json-parse-failed"), { statusCode: 502 });
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : fallback;
}

function buildVeniceMessages(
  kind: VeniceAnalysisKind,
  redacted: string,
  destination: string,
  actionType: ActionType
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "You are Oblivion's privacy cleanup agent.",
    "You only receive redacted case context — never invent or request raw emails, names, phones, or addresses.",
    "Respond with a single JSON object only (no markdown outside the JSON).",
    kind === "classify-case"
      ? '{"title":"","summary":"","risk":"standard|high-risk-safety","recommendedTask":"broker-opt-out|search-result-removal|gdpr-erasure|uk-gdpr-erasure|hibp-email-check","nextSteps":["..."]}'
      : kind === "draft-request"
        ? '{"title":"","summary":"","recommendedTask":"broker-opt-out|search-result-removal|gdpr-erasure|uk-gdpr-erasure|hibp-email-check","draftText":"","nextSteps":["..."]}'
        : '{"title":"","summary":"","recommendedTask":"broker-opt-out|search-result-removal|gdpr-erasure|uk-gdpr-erasure|hibp-email-check","approvalExplanation":"","nextSteps":["..."]}'
  ].join("\n");
  const user = [
    `Task: ${kind}`,
    `Redacted context: ${redacted}`,
    `Destination: ${destination}`,
    `Action type: ${actionType}`,
    "Keep guidance practical for a supervised cleanup agent that requires explicit user approval before disclosure."
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function parseVeniceOutput(
  kind: VeniceAnalysisKind,
  raw: Record<string, unknown>,
  actionType: ActionType
): VeniceAnalysis["output"] {
  const recommendedTask = asString(raw.recommendedTask, actionType) as ActionType;
  if (kind === "classify-case") {
    const risk = asString(raw.risk, "standard");
    return {
      title: asString(raw.title, "Case classification"),
      summary: asString(raw.summary, "Venice classified the redacted case context."),
      risk: risk === "high-risk-safety" ? "high-risk-safety" : "standard",
      recommendedTask,
      nextSteps: asStringArray(raw.nextSteps, ["Verify official removal path", "Prepare exact approval"])
    };
  }
  if (kind === "draft-request") {
    return {
      title: asString(raw.title, "Removal request draft"),
      summary: asString(raw.summary, "Draft prepared from redacted context."),
      recommendedTask,
      draftText: asString(
        raw.draftText,
        "Please remove the matching profile for the approved identifiers. Limit use to this case scope only."
      ),
      nextSteps: asStringArray(raw.nextSteps, ["Review destination", "Approve exact disclosure"])
    };
  }
  return {
    title: asString(raw.title, "Approval review"),
    summary: asString(raw.summary, "Venice reviewed the approval scope."),
    recommendedTask,
    approvalExplanation: asString(
      raw.approvalExplanation,
      "Disclose only approved categories to the named destination before expiry."
    ),
    nextSteps: asStringArray(raw.nextSteps, ["Check destination", "Check data categories"])
  };
}

export async function runVeniceAnalysis(input: {
  caseId: string;
  kind: VeniceAnalysisKind;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
  maxTokens?: number;
}): Promise<VeniceAnalysis & { tokensUsed: number }> {
  const redacted = redactText(input.notes || "Encrypted case summary unavailable to server.");
  const actionType = input.actionType ?? "broker-opt-out";
  const destination = redactText(input.destination || "approved destination");
  if (!isVeniceConfigured()) {
    throw Object.assign(new Error("venice-not-configured"), { statusCode: 503 });
  }
  const chat = await veniceChatCompletion(buildVeniceMessages(input.kind, redacted, destination, actionType), {
    maxTokens: input.maxTokens
  });
  const parsed = extractJsonObject(chat.content);
  return {
    id: `venice_${crypto.randomUUID()}`,
    caseId: input.caseId,
    kind: input.kind,
    model: veniceModel(),
    redactedInputSummary: redacted,
    output: parseVeniceOutput(input.kind, parsed, actionType),
    createdAt: new Date().toISOString(),
    tokensUsed: chat.tokensUsed
  };
}

export async function runVeniceAgentReply(input: {
  caseId: string;
  message: string;
  planStep?: string;
  presetId?: string;
  maxTokens?: number;
}): Promise<{ reply: string; tokensUsed: number }> {
  const redacted = redactText(input.message);
  if (!isVeniceConfigured()) {
    throw Object.assign(new Error("venice-not-configured"), { statusCode: 503 });
  }
  const chat = await veniceChatCompletion([
    {
      role: "system",
      content: [
        "You are Oblivion's agent in a privacy cleanup console.",
        "Answer in 2-4 short sentences. Never ask for or repeat raw PII.",
        "If the user should approve, run the next step, or connect MetaMask, say so plainly.",
        `Case step: ${input.planStep || "unknown"}. Preset: ${input.presetId || "none"}.`
      ].join("\n")
    },
    { role: "user", content: redacted }
  ], { maxTokens: input.maxTokens });
  return { reply: redactText(chat.content.trim()), tokensUsed: chat.tokensUsed };
}