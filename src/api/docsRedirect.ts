import type { ServerResponse } from "node:http";

const DEFAULT_DOCS_URL = "https://oblivion-docs.pages.dev";

export function oblivionDocsBaseUrl(): string {
  const configured = process.env.OBLIVION_DOCS_URL?.trim();
  return (configured || DEFAULT_DOCS_URL).replace(/\/$/, "");
}

export function docsUrl(path: string): string {
  const base = oblivionDocsBaseUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function redirectToDocs(response: ServerResponse, path: string, permanent = false): void {
  const location = docsUrl(path);
  response.statusCode = permanent ? 301 : 302;
  response.setHeader("Location", location);
  response.end();
}