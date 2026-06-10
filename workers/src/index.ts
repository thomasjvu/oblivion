interface Env {
  ASSETS: Fetcher;
  OBLIVION_API_ORIGIN?: string;
}

function apiOrigin(env: Env): string {
  return env.OBLIVION_API_ORIGIN?.trim().replace(/\/$/, "") || "";
}

function injectApiOrigin(html: string, origin: string): string {
  if (!origin) return html;
  const escaped = origin.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return html.replace(
    'window.OBLIVION_API_ORIGIN = "";',
    `window.OBLIVION_API_ORIGIN = '${escaped}';`
  );
}

async function proxyApiRequest(request: Request, env: Env): Promise<Response> {
  const origin = apiOrigin(env);
  if (!origin) {
    return new Response(JSON.stringify({ error: "api-origin-not-configured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const url = new URL(request.url);
  const target = new URL(`${url.pathname}${url.search}`, origin);
  const headers = new Headers(request.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return fetch(new Request(target, init));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return proxyApiRequest(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const asset = await env.ASSETS.fetch(new URL("/index.html", request.url));
      const html = await asset.text();
      const body = injectApiOrigin(html, apiOrigin(env));
      return new Response(body, {
        status: asset.status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};