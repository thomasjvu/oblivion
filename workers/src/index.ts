interface Env {
  ASSETS: Fetcher;
  OBLIVION_API_ORIGIN?: string;
}

function injectApiOrigin(html: string, apiOrigin: string): string {
  if (!apiOrigin) return html;
  const escaped = apiOrigin.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return html.replace(
    'window.OBLIVION_API_ORIGIN = "";',
    `window.OBLIVION_API_ORIGIN = '${escaped}';`
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const asset = await env.ASSETS.fetch(new URL("/index.html", request.url));
      const html = await asset.text();
      const body = injectApiOrigin(html, env.OBLIVION_API_ORIGIN?.trim() || "");
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