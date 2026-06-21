import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { redirectToDocs } from "./docsRedirect.js";
import { sanitizeForLog } from "../domain/safeLogging.js";
import { createAppStore, storePersistPath } from "../storage/createStore.js";
import { scheduleStorePersist } from "../storage/fileStore.js";
import { seedPartnersFromEnv } from "../domain/seedPartners.js";
import { processDueRechecks } from "../domain/recheck.js";
import { processDueWebhookRetries, WEBHOOK_RETRY_ENABLED } from "../domain/webhooks.js";
import { MemoryStore } from "../storage/memoryStore.js";
import { HttpError, toHttpError } from "./errors.js";
import { bindRequestOrigin, clearRequestOrigin, securityHeaders, sendJson } from "./http.js";
import { handleV1Request } from "./routes/v1.js";
import { handleConsumerApi } from "./routes/consumer.js";
import { loadTrustCenterConfigFromPath } from "./trustCenter.js";
import {
  handleAppJs,
  handleClientChunk,
  handleAssets,
  handleExamples,
  handleFavicon,
  handleFaviconAsset,
  handleFonts,
  handleIndexHtml,
  handleOpenApiYaml,
  handlePackages,
  handleSkillSh,
  handleSkills,
  handleStylesCss
} from "./static.js";

export interface AppOptions {
  store?: MemoryStore;
  publicDir?: string;
  trustCenterPath?: string;
}

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? createAppStore();
  seedPartnersFromEnv(store);
  const persistPath = options.store ? null : storePersistPath();
  const publicDir = options.publicDir ?? join(process.cwd(), "public");
  const skillsDir = join(process.cwd(), "skills");
  const cwd = process.cwd();
  const trustCenterPath =
    options.trustCenterPath ?? process.env.TRUST_CENTER_PATH ?? join(process.cwd(), "config", "trust-center.json");

  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    bindRequestOrigin(typeof request.headers.origin === "string" ? request.headers.origin : undefined);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (
        method === "OPTIONS" &&
        (url.pathname.startsWith("/api/") ||
          url.pathname.startsWith("/v1/") ||
          url.pathname.startsWith("/examples/") ||
          url.pathname.startsWith("/packages/"))
      ) {
        response.writeHead(204, securityHeaders());
        response.end();
        return;
      }

      if (url.pathname.startsWith("/v1/")) {
        const handled = await handleV1Request(request, response, url, {
          store,
          trustCenterPath,
          loadTrustCenterConfig: () => loadTrustCenterConfigFromPath(trustCenterPath)
        });
        if (handled) return;
      }

      const docRedirects: Record<string, string> = {
        "/help": "/docs/user-guide/overview",
        "/developers": "/docs/developers/partner-api",
        "/onboarding": "/docs/developers/partner-onboarding",
        "/privacy": "/docs/legal/privacy",
        "/terms": "/docs/legal/terms",
        "/pricing": "/docs/pricing",
        "/llms": "/llms",
        "/llms.txt": "/llms.txt"
      };
      if (method === "GET" && url.pathname in docRedirects) {
        redirectToDocs(response, docRedirects[url.pathname], process.env.NODE_ENV === "production");
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/favicon/")) {
        await handleFaviconAsset(response, url.pathname.slice("/favicon/".length), publicDir);
        return;
      }

      if (method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg")) {
        await handleFavicon(response, publicDir, url.pathname);
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        await handleIndexHtml(response, publicDir);
        return;
      }

      if (method === "GET" && url.pathname === "/styles.css") {
        await handleStylesCss(response, publicDir);
        return;
      }

      if (method === "GET" && url.pathname === "/app.js") {
        await handleAppJs(response, publicDir);
        return;
      }

      if (method === "GET" && url.pathname.endsWith(".js") && url.pathname.startsWith("/chunk-")) {
        await handleClientChunk(response, url.pathname.slice(1), publicDir);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/assets/")) {
        await handleAssets(response, url.pathname.slice("/assets/".length), publicDir);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/fonts/")) {
        await handleFonts(response, url.pathname.slice("/fonts/".length), publicDir);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/packages/")) {
        await handlePackages(response, url.pathname.slice("/packages/".length), cwd);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/examples/")) {
        await handleExamples(response, url.pathname.slice("/examples/".length), cwd);
        return;
      }

      if (method === "GET" && url.pathname === "/docs/openapi-v1.yaml") {
        await handleOpenApiYaml(response, cwd);
        return;
      }

      if (method === "GET" && url.pathname === "/skill.sh") {
        await handleSkillSh(response, cwd);
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/skills/")) {
        await handleSkills(response, url.pathname.slice("/skills/".length), skillsDir);
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const handled = await handleConsumerApi(request, response, url, {
          store,
          trustCenterPath,
          loadTrustCenterConfig: () => loadTrustCenterConfigFromPath(trustCenterPath)
        });
        if (handled) return;
      }

      throw new HttpError(404, "not-found");
    } catch (error) {
      const httpError = toHttpError(error);
      sendJson(response, httpError.statusCode, {
        error: httpError.message,
        details: sanitizeForLog(httpError.details)
      });
    } finally {
      if (persistPath) scheduleStorePersist(store, persistPath);
      clearRequestOrigin();
    }
  }

  const webhookRetryIntervalMs = Number(process.env.OBLIVION_WEBHOOK_RETRY_INTERVAL_MS || "60000");
  const webhookSchedulerEnabled =
    WEBHOOK_RETRY_ENABLED &&
    process.env.OBLIVION_WEBHOOK_SCHEDULER !== "false" &&
    process.env.NODE_ENV !== "test";
  const maintenanceSchedulerEnabled =
    process.env.OBLIVION_MAINTENANCE_SCHEDULER !== "false" && process.env.NODE_ENV !== "test";
  const webhookRetryTimer =
    webhookSchedulerEnabled || maintenanceSchedulerEnabled
      ? setInterval(() => {
          if (webhookSchedulerEnabled) void processDueWebhookRetries(store);
          if (maintenanceSchedulerEnabled) void processDueRechecks(store);
        }, webhookRetryIntervalMs)
      : undefined;
  if (webhookRetryTimer && typeof webhookRetryTimer.unref === "function") {
    webhookRetryTimer.unref();
  }

  return {
    store,
    handler,
    server: createServer((request, response) => {
      void handler(request, response);
    }),
    stopWebhookScheduler: () => {
      if (webhookRetryTimer) clearInterval(webhookRetryTimer);
    }
  };
}