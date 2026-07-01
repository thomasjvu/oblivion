import type { IncomingMessage, ServerResponse } from "node:http";
import { CLEANUP_PRESETS } from "../../../domain/cleanup.js";
import { listBrokerCatalogSummary } from "../../../domain/brokerCatalog.js";
import { oblivionPublicApiUrl } from "../../../domain/integrations.js";
import {
  assertPreviewQuota,
  previewDailyLimit,
  recordPreviewUsage,
  runDiscoveryPreview
} from "../../../domain/discoveryPreview.js";
import { clientIp } from "../../clientIp.js";
import { readJson, sendJson } from "../../http.js";
import type { ConsumerContext } from "./context.js";

export async function handleConsumerMetaRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/skills") {
    sendJson(response, 200, {
      skills: [
        {
          id: "clean-online-identity",
          name: "Clean Online Identity",
          description:
            "Supervised personal data removal across brokers, search results, and privacy rights workflows.",
          repository: "thomasjvu/oblivion",
          skillPath: "skills/clean-online-identity",
          install: {
            npx: "npx skills add thomasjvu/oblivion --skill clean-online-identity",
            curl: "curl -fsSL {origin}/skill.sh | bash",
            skillMd: "/skills/clean-online-identity/SKILL.md",
            manifest: "/skills/clean-online-identity/manifest.json"
          }
        }
      ]
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/presets") {
    sendJson(response, 200, { presets: CLEANUP_PRESETS });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/brokers") {
    const brokers = listBrokerCatalogSummary();
    sendJson(response, 200, { brokers, count: brokers.length });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/discovery/preview") {
    const body = await readJson<{
      personLabel?: string;
      aliases?: string[];
      regionLabel?: string;
      walletAddress?: string;
    }>(request);
    const ip = clientIp(request);
    assertPreviewQuota(store, ip, body.walletAddress);
    const preview = await runDiscoveryPreview({
      personLabel: body.personLabel || "",
      aliases: body.aliases,
      regionLabel: body.regionLabel
    });
    const remainingPreviews = recordPreviewUsage(store, ip, body.walletAddress);
    sendJson(response, 200, {
      candidates: preview.candidates,
      stats: preview.stats,
      remainingPreviews,
      dailyLimit: previewDailyLimit()
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      apiOrigin: oblivionPublicApiUrl() || null,
      corsOrigin: process.env.OBLIVION_CORS_ORIGIN?.trim() || null
    });
    return true;
  }

  return false;
}