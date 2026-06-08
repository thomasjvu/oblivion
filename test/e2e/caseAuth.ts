import type { Page } from "@playwright/test";

export async function caseAuthHeaders(page: Page, caseId: string): Promise<Record<string, string>> {
  const token = await page.evaluate((id) => {
    try {
      const raw = localStorage.getItem("oblivion.caseTokens");
      const tokens = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return tokens[id];
    } catch {
      return undefined;
    }
  }, caseId);
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

export async function caseFetch(
  page: Page,
  caseId: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const headers = await caseAuthHeaders(page, caseId);
  return page.evaluate(
    async ({ url, method, body, auth }) => {
      const response = await fetch(url, {
        method: method || "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...auth
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    },
    {
      url: path,
      method: init.method,
      body: init.body,
      auth: headers
    }
  ).then((result) => {
    if (!result.ok) throw new Error(result.text);
    return new Response(result.text, { status: result.status });
  });
}