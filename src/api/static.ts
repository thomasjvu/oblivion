import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendBytes, sendJson, sendText } from "./http.js";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon"
};

const FONT_CONTENT_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".otf": "font/otf"
};

const SKILL_CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "application/x-sh; charset=utf-8"
};

export interface StaticDirs {
  publicDir: string;
  skillsDir: string;
  cwd?: string;
}

export function serveStaticWithTraversalGuard(
  relativePath: string,
  options: { allowSubdirs?: boolean } = {}
): boolean {
  if (!relativePath || relativePath.includes("..")) return false;
  if (!options.allowSubdirs && relativePath.includes("/")) return false;
  return true;
}

export async function handleFavicon(
  response: ServerResponse,
  publicDir: string,
  pathname: string
): Promise<void> {
  if (pathname === "/favicon.svg") {
    const bytes = await readFile(join(publicDir, "favicon/favicon-32x32.png"));
    sendBytes(response, 200, bytes, "image/png", "public, max-age=86400");
    return;
  }
  const bytes = await readFile(join(publicDir, "favicon/favicon.ico"));
  sendBytes(response, 200, bytes, "image/x-icon", "public, max-age=86400");
}

export async function handleFaviconAsset(
  response: ServerResponse,
  assetName: string,
  publicDir: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(assetName, { allowSubdirs: false })) {
    sendJson(response, 400, { error: "invalid-favicon-path" });
    return;
  }
  const contentType = ASSET_CONTENT_TYPES[extname(assetName).toLowerCase()];
  if (!contentType) {
    sendJson(response, 404, { error: "favicon-not-found" });
    return;
  }
  try {
    const bytes = await readFile(join(publicDir, "favicon", assetName));
    sendBytes(response, 200, bytes, contentType, "public, max-age=86400");
  } catch {
    sendJson(response, 404, { error: "favicon-not-found" });
  }
}

export async function handleIndexHtml(response: ServerResponse, publicDir: string): Promise<void> {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  sendText(response, 200, html, "text/html");
}

export async function handleStylesCss(response: ServerResponse, publicDir: string): Promise<void> {
  const css = await readFile(join(publicDir, "styles.css"), "utf8");
  sendText(response, 200, css, "text/css");
}

export async function handleAppJs(response: ServerResponse, publicDir: string): Promise<void> {
  const js = await readFile(join(publicDir, "app.js"), "utf8");
  sendText(response, 200, js, "application/javascript");
}

export async function handleAssets(
  response: ServerResponse,
  assetName: string,
  publicDir: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(assetName, { allowSubdirs: true })) {
    sendJson(response, 400, { error: "invalid-asset-path" });
    return;
  }
  const contentType = ASSET_CONTENT_TYPES[extname(assetName).toLowerCase()];
  if (!contentType) {
    sendJson(response, 404, { error: "asset-not-found" });
    return;
  }
  try {
    const bytes = await readFile(join(publicDir, "assets", assetName));
    sendBytes(response, 200, bytes, contentType);
  } catch {
    sendJson(response, 404, { error: "asset-not-found" });
  }
}

export async function handleFonts(
  response: ServerResponse,
  fontName: string,
  publicDir: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(fontName)) {
    sendJson(response, 400, { error: "invalid-font-path" });
    return;
  }
  const contentType = FONT_CONTENT_TYPES[extname(fontName).toLowerCase()];
  if (!contentType) {
    sendJson(response, 404, { error: "font-not-found" });
    return;
  }
  try {
    const bytes = await readFile(join(publicDir, "fonts", fontName));
    sendBytes(response, 200, bytes, contentType, "public, max-age=604800");
  } catch {
    sendJson(response, 404, { error: "font-not-found" });
  }
}

export async function handlePackages(
  response: ServerResponse,
  packagePath: string,
  cwd: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(packagePath, { allowSubdirs: true })) {
    sendJson(response, 400, { error: "invalid-package-path" });
    return;
  }
  const contentType = packagePath.endsWith(".html")
    ? "text/html; charset=utf-8"
    : packagePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : packagePath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/plain; charset=utf-8";
  try {
    const content = await readFile(join(cwd, "packages", packagePath), "utf8");
    sendText(response, 200, content, contentType.split(";")[0]);
  } catch {
    sendJson(response, 404, { error: "package-asset-not-found" });
  }
}

export async function handleExamples(
  response: ServerResponse,
  examplePath: string,
  cwd: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(examplePath, { allowSubdirs: true })) {
    sendJson(response, 400, { error: "invalid-example-path" });
    return;
  }
  const contentType = examplePath.endsWith(".html")
    ? "text/html; charset=utf-8"
    : examplePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : "text/plain; charset=utf-8";
  try {
    const content = await readFile(join(cwd, "examples", examplePath), "utf8");
    sendText(response, 200, content, contentType.split(";")[0]);
  } catch {
    sendJson(response, 404, { error: "example-not-found" });
  }
}

export async function handleSkills(
  response: ServerResponse,
  skillPath: string,
  skillsDir: string
): Promise<void> {
  if (!serveStaticWithTraversalGuard(skillPath, { allowSubdirs: true })) {
    sendJson(response, 400, { error: "invalid-skill-path" });
    return;
  }
  const contentType = SKILL_CONTENT_TYPES[extname(skillPath).toLowerCase()];
  if (!contentType) {
    sendJson(response, 404, { error: "skill-not-found" });
    return;
  }
  try {
    const bytes = await readFile(join(skillsDir, skillPath));
    sendBytes(response, 200, bytes, contentType, "public, max-age=3600");
  } catch {
    sendJson(response, 404, { error: "skill-not-found" });
  }
}

export async function handleOpenApiYaml(response: ServerResponse, cwd: string): Promise<void> {
  try {
    const yaml = await readFile(join(cwd, "spec", "openapi-v1.yaml"), "utf8");
    sendText(response, 200, yaml, "application/yaml");
  } catch {
    sendJson(response, 404, { error: "openapi-not-found" });
  }
}

export async function handleSkillSh(response: ServerResponse, cwd: string): Promise<void> {
  try {
    const script = await readFile(join(cwd, "skill.sh"), "utf8");
    sendText(response, 200, script, "application/x-sh");
  } catch {
    sendJson(response, 404, { error: "skill-installer-not-found" });
  }
}