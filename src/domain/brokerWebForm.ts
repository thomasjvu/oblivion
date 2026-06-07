const FORM_RE = /<form\b[^>]*>/gi;
const INPUT_NAME_RE = /<input\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi;
const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|turnstile/i;

export interface BrokerFormProbe {
  reachable: boolean;
  status?: number;
  formCount: number;
  formAction?: string;
  method?: string;
  fieldNames: string[];
  requiresCaptcha: boolean;
  summary: string;
}

export async function probeBrokerOptOutForm(url: string): Promise<BrokerFormProbe> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "oblivion-privacy-agent/1.0 (+https://oblivion.phantasy.bot)" },
      redirect: "follow"
    });
    const html = await response.text();
    const forms = [...html.matchAll(FORM_RE)];
    const fieldNames = new Set<string>();
    for (const match of html.matchAll(INPUT_NAME_RE)) {
      const name = match[1]?.trim();
      if (name && !name.startsWith("_")) fieldNames.add(name);
    }
    const firstForm = forms[0]?.[0] ?? "";
    const actionMatch = firstForm.match(/\baction=["']([^"']+)["']/i);
    const methodMatch = firstForm.match(/\bmethod=["']([^"']+)["']/i);
    const requiresCaptcha = CAPTCHA_RE.test(html);
    const names = [...fieldNames].sort();
    const formAction = actionMatch?.[1];
    const method = (methodMatch?.[1] ?? "get").toLowerCase();
    const summary =
      response.ok && forms.length > 0
        ? `Detected ${forms.length} form(s) with fields: ${names.slice(0, 8).join(", ") || "none"}${
            names.length > 8 ? "…" : ""
          }.${requiresCaptcha ? " CAPTCHA present — user-held submission required." : ""}`
        : response.ok
          ? "Official page reachable but no HTML form detected — open manually."
          : `Opt-out page returned HTTP ${response.status}.`;
    return {
      reachable: response.ok,
      status: response.status,
      formCount: forms.length,
      formAction,
      method,
      fieldNames: names,
      requiresCaptcha,
      summary
    };
  } catch {
    return {
      reachable: false,
      formCount: 0,
      fieldNames: [],
      requiresCaptcha: false,
      summary: "Could not fetch the official opt-out page."
    };
  }
}

export function brokerWebFormAutomationEnabled(): boolean {
  return process.env.BROKER_WEBFORM_AUTOMATION === "true";
}