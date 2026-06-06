import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { buildAttestationProof, type TrustCenterConfig } from "../domain/attestation.js";
import {
  buildAgentPlanView,
  CLEANUP_PRESETS,
  createAgentPlan,
  getPreset
} from "../domain/cleanup.js";
import {
  createAgentDelegationSet,
  createEip7702Authorization,
  createErc7715Permission,
  createPaymentPermission,
  createPaymentSession,
  createRelayerEvents,
  createTimelineEvent,
  demoSmartAccountAddress,
  X402_PRODUCTS
} from "../domain/hackathon.js";
import { canExecuteWithApproval } from "../domain/policy.js";
import {
  buildAgentNextStep,
  buildHackathonStatusForCase,
  buildStatus,
  proposeApprovedAction,
  runCleanupAgentStep
} from "../domain/orchestration.js";
import { redactText } from "../domain/redaction.js";
import { executeApprovedAction } from "../domain/executor.js";
import {
  applyFindingDecision,
  discoverExposureCandidates,
  discoveryReadinessMessage
} from "../domain/exposureDiscovery.js";
import {
  isBraveSearchConfigured,
  isHibpConfigured,
  isLiveExecutorEnabled,
  isOneShotConfigured,
  isX402Configured
} from "../domain/integrations.js";
import { relayOneShotForCase, type OneShotRelayBody } from "../domain/oneshot.js";
import {
  applyX402HttpResult,
  markSessionPaid,
  processX402Request,
  settleX402Payment,
  x402PublicConfig
} from "../domain/x402.js";
import { isVeniceConfigured, runVeniceAgentReply, runVeniceAnalysis } from "../domain/venice.js";
import { sanitizeForLog } from "../domain/safeLogging.js";
import type {
  ActionType,
  AgentName,
  AutonomyMode,
  AuthorityBasis,
  CaseRecord,
  EncryptedBlob,
  IdentifierCategory,
  Jurisdiction,
  PaymentMode,
  PresetId,
  RedactedScope,
  RelayerStatus,
  RiskLevel
} from "../domain/types.js";
import { MemoryStore } from "../storage/memoryStore.js";
import { HttpError, toHttpError } from "./errors.js";
import { readJson, sendBytes, sendJson, sendText } from "./http.js";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4"
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
import { handleConnectorRoutes } from "./routes/connectors.js";

export interface AppOptions {
  store?: MemoryStore;
  publicDir?: string;
  trustCenterPath?: string;
}

interface CreateCaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  retentionDays?: number;
}

interface IntakeBody {
  encryptedIntake: EncryptedBlob;
  redactedScope: RedactedScope;
}

interface ProposeActionBody {
  caseId: string;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  sourceVerified?: boolean;
  plaintextPreview?: string;
  expectedConfirmationStep?: string;
}

interface ApproveBody {
  userConfirmation: string;
}

interface CaseBody {
  caseId: string;
}

interface SmartAccountBody {
  caseId: string;
  walletAddress: string;
  mode?: "demo" | "live";
  txHash?: string;
  callsId?: string;
  chainId?: number;
}

interface PaymentBody {
  caseId: string;
  productId?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

interface VeniceBody {
  caseId: string;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
}

interface AgentDelegateBody {
  caseId: string;
}

interface AgentMessageBody {
  caseId: string;
  fromAgent?: string;
  toAgent?: string;
  purpose: string;
  payload?: string;
}

interface RelayerBody extends OneShotRelayBody {}

interface ExecuteActionBody {
  hashPrefix?: string;
  emailLabel?: string;
  sourceUrl?: string;
}

interface AgentRunBody {
  caseId: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

interface ApplyPresetBody {
  presetId: PresetId;
  autonomyMode?: AutonomyMode;
}

interface CaseAgentRunBody {
  highAutonomy?: boolean;
}

interface PremiumTaskBody {
  caseId: string;
  paymentSessionId?: string;
}

function escapeHelpHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatHelpInline(text: string): string {
  let html = escapeHelpHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );
  return html;
}

function staticDocPageFromMarkdown(
  markdown: string,
  options: { pageTitle: string; heading: string }
): string {
  const lines = markdown.split("\n");
  const parts: string[] = [];
  let inTable = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("|")) {
      closeList();
      if (!inTable) {
        parts.push("<table>");
        inTable = true;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.every((cell) => /^-+$/.test(cell.replace(/:/g, "")))) continue;
      parts.push(`<tr>${cells.map((c) => `<td>${formatHelpInline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    if (inTable) {
      parts.push("</table>");
      inTable = false;
    }
    if (line.startsWith("# ")) {
      closeList();
      parts.push(`<h1>${formatHelpInline(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      parts.push(`<h2>${formatHelpInline(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      parts.push(`<h3>${formatHelpInline(line.slice(4))}</h3>`);
    } else if (/^\d+\.\s/.test(line)) {
      closeList();
      parts.push(`<p class="step-line">${formatHelpInline(line)}</p>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${formatHelpInline(line.slice(2))}</li>`);
    } else if (line.trim() === "---") {
      closeList();
      parts.push("<hr />");
    } else if (line.trim()) {
      closeList();
      parts.push(`<p>${formatHelpInline(line)}</p>`);
    }
  }
  closeList();
  if (inTable) parts.push("</table>");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Oblivion — ${escapeHelpHtml(options.pageTitle)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app help-page">
    <header class="topbar">
      <div class="brand"><div class="mark">O</div><h1>${escapeHelpHtml(options.heading)}</h1></div>
      <div class="nav-actions"><a class="secondary help-back" href="/">← Home</a></div>
    </header>
    <article class="help-article">${parts.join("\n")}</article>
    <footer class="site-footer help-page-footer">
      <nav class="site-footer-legal" aria-label="Legal">
        <a class="site-footer-text-link" href="/privacy">Privacy</a>
        <a class="site-footer-text-link" href="/terms">Terms</a>
      </nav>
    </footer>
  </div>
</body>
</html>`;
}

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const publicDir = options.publicDir ?? join(process.cwd(), "public");
  const skillsDir = join(process.cwd(), "skills");
  const trustCenterPath =
    options.trustCenterPath ?? process.env.TRUST_CENTER_PATH ?? join(process.cwd(), "config", "trust-center.json");

  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/help") {
        const guidePath = join(process.cwd(), "docs", "USER_GUIDE.md");
        const markdown = await readFile(guidePath, "utf8");
        sendText(
          response,
          200,
          staticDocPageFromMarkdown(markdown, { pageTitle: "User Guide", heading: "Guide" }),
          "text/html"
        );
        return;
      }

      if (method === "GET" && url.pathname === "/privacy") {
        const privacyPath = join(process.cwd(), "docs", "PRIVACY_POLICY.md");
        const markdown = await readFile(privacyPath, "utf8");
        sendText(
          response,
          200,
          staticDocPageFromMarkdown(markdown, { pageTitle: "Privacy Policy", heading: "Privacy" }),
          "text/html"
        );
        return;
      }

      if (method === "GET" && url.pathname === "/terms") {
        const termsPath = join(process.cwd(), "docs", "TERMS_OF_SERVICE.md");
        const markdown = await readFile(termsPath, "utf8");
        sendText(
          response,
          200,
          staticDocPageFromMarkdown(markdown, { pageTitle: "Terms of Service", heading: "Terms" }),
          "text/html"
        );
        return;
      }

      if (method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg")) {
        const faviconPath = join(publicDir, "favicon.svg");
        const svg = await readFile(faviconPath, "utf8");
        sendText(response, 200, svg, "image/svg+xml");
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        const html = await readFile(join(publicDir, "index.html"), "utf8");
        sendText(response, 200, html, "text/html");
        return;
      }

      if (method === "GET" && url.pathname === "/styles.css") {
        const css = await readFile(join(publicDir, "styles.css"), "utf8");
        sendText(response, 200, css, "text/css");
        return;
      }

      if (method === "GET" && url.pathname === "/app.js") {
        const js = await readFile(join(publicDir, "app.js"), "utf8");
        sendText(response, 200, js, "application/javascript");
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/assets/")) {
        const assetName = url.pathname.slice("/assets/".length);
        if (!assetName || assetName.includes("/") || assetName.includes("..")) {
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
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/fonts/")) {
        const fontName = url.pathname.slice("/fonts/".length);
        if (!fontName || fontName.includes("/") || fontName.includes("..")) {
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
        return;
      }

      if (method === "GET" && url.pathname === "/skill.sh") {
        try {
          const script = await readFile(join(process.cwd(), "skill.sh"), "utf8");
          sendText(response, 200, script, "application/x-sh");
        } catch {
          sendJson(response, 404, { error: "skill-installer-not-found" });
        }
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/skills/")) {
        const skillPath = url.pathname.slice("/skills/".length);
        if (!skillPath || skillPath.includes("..")) {
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
        return;
      }

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
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/presets") {
        sendJson(response, 200, { presets: CLEANUP_PRESETS });
        return;
      }

      if (method === "GET" && url.pathname === "/api/cases") {
        sendJson(response, 200, {
          cases: [...store.cases.values()]
            .filter((caseRecord) => !caseRecord.deletedAt)
            .map((caseRecord) => ({
              id: caseRecord.id,
              jurisdiction: caseRecord.jurisdiction,
              riskLevel: caseRecord.riskLevel,
              authorityBasis: caseRecord.authorityBasis,
              retentionDays: caseRecord.retentionDays,
              createdAt: caseRecord.createdAt,
              updatedAt: caseRecord.updatedAt,
              redactedScope: caseRecord.redactedScope ?? null,
              status: buildStatus(store, caseRecord.id)
            }))
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/cases") {
        const body = await readJson<CreateCaseBody>(request);
        const caseRecord = createCaseRecord(body);
        store.cases.set(caseRecord.id, caseRecord);
        sendJson(response, 201, { case: caseRecord, status: buildStatus(store, caseRecord.id) });
        return;
      }

      const caseReadMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
      if (method === "GET" && caseReadMatch) {
        const caseRecord = store.getCaseOrThrow(caseReadMatch[1]);
        sendJson(response, 200, {
          case: caseRecord,
          status: buildStatus(store, caseRecord.id)
        });
        return;
      }

      const presetMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/preset$/);
      if (method === "POST" && presetMatch) {
        const body = await readJson<ApplyPresetBody>(request);
        const caseRecord = store.getCaseOrThrow(presetMatch[1]);
        const plan = createAgentPlan({
          caseRecord,
          presetId: body.presetId,
          autonomyMode: body.autonomyMode
        });
        store.agentPlans.set(plan.id, plan);
        const preset = getPreset(plan.presetId);
        const timeline = createTimelineEvent(
          caseRecord.id,
          "OblivionRoot",
          "Preset selected",
          `${preset.title} started in ${plan.autonomyMode} mode.`
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, {
          preset,
          plan: buildAgentPlanView(plan),
          timeline,
          status: buildStatus(store, caseRecord.id)
        });
        return;
      }

      const planMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/plan$/);
      if (method === "GET" && planMatch) {
        const caseRecord = store.getCaseOrThrow(planMatch[1]);
        const plan = store.agentPlanForCase(caseRecord.id);
        sendJson(response, 200, {
          plan: plan ? buildAgentPlanView(plan) : null,
          presets: CLEANUP_PRESETS,
          connectorResults: store.connectorResultsForCase(caseRecord.id),
          timeline: store.agentTimelineForCase(caseRecord.id)
        });
        return;
      }

      const caseAgentRunMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/agent\/run$/);
      if (method === "POST" && caseAgentRunMatch) {
        const body = await readJson<CaseAgentRunBody>(request);
        const caseRecord = store.getCaseOrThrow(caseAgentRunMatch[1]);
        const result = await runCleanupAgentStep({
          store,
          caseRecord,
          trustCenterConfig: () => loadTrustCenterConfig(trustCenterPath),
          highAutonomy: body.highAutonomy
        });
        sendJson(response, 200, result);
        return;
      }

      const intakeMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/intake$/);
      if (method === "POST" && intakeMatch) {
        const body = await readJson<IntakeBody>(request);
        const caseRecord = store.getCaseOrThrow(intakeMatch[1]);
        validateEncryptedBlob(body.encryptedIntake);
        caseRecord.encryptedIntake = body.encryptedIntake;
        caseRecord.redactedScope = sanitizeScope(body.redactedScope);
        caseRecord.updatedAt = new Date().toISOString();
        sendJson(response, 200, { case: caseRecord, status: buildStatus(store, caseRecord.id) });
        return;
      }

      const findingsListMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings$/);
      if (method === "GET" && findingsListMatch) {
        const caseRecord = store.getCaseOrThrow(findingsListMatch[1]);
        const status = buildStatus(store, caseRecord.id);
        sendJson(response, 200, {
          findings: status.findings,
          pendingFindings: status.pendingFindings,
          confirmedFindings: status.confirmedFindings,
          discovery: discoveryReadinessMessage()
        });
        return;
      }

      const findingsDiscoverMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/discover$/);
      if (method === "POST" && findingsDiscoverMatch) {
        const caseRecord = store.getCaseOrThrow(findingsDiscoverMatch[1]);
        const body = await readJson<{ pastedUrls?: string[] }>(request);
        const existingUrls = store.exposuresForCase(caseRecord.id).map((item) => item.sourceUrl);
        try {
          const discovered = await discoverExposureCandidates({
            caseId: caseRecord.id,
            scope: caseRecord.redactedScope,
            pastedUrls: body.pastedUrls,
            existingUrls
          });
          for (const exposure of discovered) {
            store.exposures.set(exposure.id, exposure);
          }
          const timeline = createTimelineEvent(
            caseRecord.id,
            "ScoutAgent",
            "Discovery run",
            discovered.length
              ? `${discovered.length} candidate link(s) added for review.`
              : "No new candidates. Paste URLs or configure Brave search."
          );
          store.agentTimeline.set(timeline.id, timeline);
          sendJson(response, 201, {
            discovered,
            status: buildStatus(store, caseRecord.id),
            timeline,
            discovery: discoveryReadinessMessage()
          });
        } catch (error) {
          throw new HttpError(502, "discovery-failed", {
            message: discoveryReadinessMessage(),
            detail: sanitizeForLog(error)
          });
        }
        return;
      }

      const findingConfirmMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/findings\/([^/]+)\/(confirm|reject)$/);
      if (method === "POST" && findingConfirmMatch) {
        const caseRecord = store.getCaseOrThrow(findingConfirmMatch[1]);
        const exposure = store.exposures.get(findingConfirmMatch[2]);
        if (!exposure || exposure.caseId !== caseRecord.id) {
          throw new HttpError(404, "finding-not-found");
        }
        const decision = findingConfirmMatch[3] === "confirm" ? "confirmed" : "rejected";
        const updated = applyFindingDecision(exposure, decision);
        store.exposures.set(updated.id, updated);
        const timeline = createTimelineEvent(
          caseRecord.id,
          "ScoutAgent",
          decision === "confirmed" ? "Match confirmed" : "Match rejected",
          redactText(updated.sourceUrl)
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 200, { exposure: updated, status: buildStatus(store, caseRecord.id), timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/propose") {
        const body = await readJson<ProposeActionBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const { approval, action } = proposeApprovedAction({
          store,
          caseRecord,
          body: {
            ...body,
            identifiers: body.identifiers ?? [],
            dataToDisclose: body.dataToDisclose ?? []
          }
        });
        sendJson(response, 201, {
          policy: { allowed: true, reasons: [] },
          approval,
          action,
          status: buildStatus(store, caseRecord.id)
        });
        return;
      }

      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (method === "POST" && approveMatch) {
        const approval = store.approvals.get(approveMatch[1]);
        if (!approval) throw new HttpError(404, "approval-not-found");
        const body = await readJson<ApproveBody>(request);
        if (!body.userConfirmation || body.userConfirmation.length < 8) {
          throw new HttpError(422, "user-confirmation-required");
        }
        approval.status = "approved";
        approval.approvedAt = new Date().toISOString();
        approval.userConfirmation = redactText(body.userConfirmation);
        for (const action of store.actions.values()) {
          if (action.approvalId === approval.id) action.executionStatus = "ready";
        }
        sendJson(response, 200, { approval, status: buildStatus(store, approval.caseId) });
        return;
      }

      const executeMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
      if (method === "POST" && executeMatch) {
        const action = store.actions.get(executeMatch[1]);
        if (!action) throw new HttpError(404, "action-not-found");
        const approval = store.approvals.get(action.approvalId);
        if (!approval) throw new HttpError(409, "approval-missing");
        const decision = canExecuteWithApproval(approval);
        if (!decision.allowed) {
          action.executionStatus = "blocked";
          throw new HttpError(403, "execution-blocked", { reasons: decision.reasons });
        }
        const handoff = await readJson<ExecuteActionBody>(request);
        const executed = await executeApprovedAction({
          store,
          action,
          approval,
          trustCenterConfig: await loadTrustCenterConfig(trustCenterPath),
          handoff
        });
        action.executionStatus = executed.connectorResult?.status === "failed" ? "failed" : "recorded";
        action.executedAt = new Date().toISOString();
        action.executionRecord = executed.executionRecord;
        approval.status = "used";
        sendJson(response, 200, {
          action,
          approval,
          executorMode: executed.mode,
          connectorResult: executed.connectorResult,
          status: buildStatus(store, action.caseId)
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/trust/attestation") {
        const config = await loadTrustCenterConfig(trustCenterPath);
        const fetchLive = url.searchParams.get("live") !== "0";
        sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
        return;
      }

      if (method === "GET" && url.pathname === "/api/trust/privacy") {
        sendJson(response, 200, {
          storedPlaintext: false,
          serverCanDecryptCaseVault: false,
          rawPiiToNonTeeLlm: false,
          defaultExecutor: "record-only",
          sensitiveActionRequiresApproval: true,
          thirdPartyDisclosureStillPossible: true,
          message:
            "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties, and sensitive plaintext should only be decrypted in the browser or an attested TEE task."
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/x402/products") {
        sendJson(response, 200, {
          products: X402_PRODUCTS,
          config: x402PublicConfig(),
          note: isX402Configured()
            ? "Live x402 catalog. Pay protected agent routes with PAYMENT-SIGNATURE, then ERC-7710 scopes still govern cleanup disclosure."
            : "Configure X402_PAY_TO and X402_FACILITATOR_URL for live HTTP 402 settlement."
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/x402/config") {
        sendJson(response, 200, x402PublicConfig());
        return;
      }

      if (method === "GET" && url.pathname === "/api/integrations/wallet-config") {
        const chainId = Number(process.env.WALLET_CHAIN_ID || "11155111");
        const liveEnabled = process.env.WALLET_LIVE_MODE === "true";
        sendJson(response, 200, {
          mode: liveEnabled ? "live" : "demo",
          liveEnabled,
          chainId,
          chainIdHex: `0x${chainId.toString(16)}`,
          addChainParams: {
            chainId: `0x${chainId.toString(16)}`,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.sepolia.org"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"]
          },
          poll: { attempts: 12, delayMs: 1500 }
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/integrations/status") {
        sendJson(response, 200, {
          mode: isVeniceConfigured() ? "live-agent" : "wallet-and-policy",
          executorMode: isLiveExecutorEnabled() ? "live" : "record-only",
          liveReady: {
            metamaskSmartAccounts: process.env.WALLET_LIVE_MODE === "true",
            x402: isX402Configured(),
            erc7710: isX402Configured(),
            venice: isVeniceConfigured(),
            oneShot: isOneShotConfigured(),
            hibpEmail: isHibpConfigured(),
            braveSearch: isBraveSearchConfigured(),
            liveExecutor: isLiveExecutorEnabled(),
            phalaAttestation: Boolean(process.env.PHALA_ATTESTATION_URL)
          },
          privacyInvariant:
            "Live adapters must stay behind the same approval, redaction, logging, and attestation gates."
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/metamask/demo-session") {
        const body = await readJson<SmartAccountBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        if (!body.walletAddress || !body.walletAddress.startsWith("0x")) {
          throw new HttpError(422, "wallet-address-required");
        }
        const sessionMode = body.mode === "live" ? "live" : "demo";
        const eip7702 = createEip7702Authorization(caseRecord.id, body.walletAddress);
        const erc7715 = createErc7715Permission(caseRecord.id);
        store.permissionGrants.set(eip7702.id, eip7702);
        store.permissionGrants.set(erc7715.id, erc7715);
        const smartDetail =
          sessionMode === "live"
            ? `EIP-7702 authorization recorded after MetaMask batch${body.txHash ? ` (${body.txHash.slice(0, 10)}…)` : ""}.`
            : "EIP-7702 demo authorization created.";
        const timeline = [
          createTimelineEvent(caseRecord.id, "MetaMask", "Smart Account session", smartDetail),
          createTimelineEvent(
            caseRecord.id,
            "MetaMask",
            "ERC-7715 permission",
            "Advanced permission grants only task proposal, approval request, and narrow redelegation."
          )
        ];
        timeline.forEach((event) => store.agentTimeline.set(event.id, event));
        sendJson(response, 201, {
          mode: sessionMode,
          walletAddress: redactText(body.walletAddress),
          smartAccountAddress: demoSmartAccountAddress(body.walletAddress),
          txHash: body.txHash,
          callsId: body.callsId,
          chainId: body.chainId,
          permissions: [eip7702, erc7715],
          timeline
        });
        return;
      }

      if (method === "POST" && (url.pathname === "/api/x402/one-off" || url.pathname === "/api/x402/subscription")) {
        const mode: PaymentMode = url.pathname.endsWith("subscription") ? "subscription" : "one-off";
        const body = await readJson<PaymentBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const session = createPaymentSession({
          caseId: caseRecord.id,
          mode,
          productId: body.productId,
          walletAddress: body.walletAddress ? redactText(body.walletAddress) : undefined,
          smartAccountAddress: body.smartAccountAddress
        });
        const permission = createPaymentPermission(caseRecord.id, session);
        store.paymentSessions.set(session.id, session);
        store.permissionGrants.set(permission.id, permission);
        const timeline = createTimelineEvent(
          caseRecord.id,
          "x402",
          mode === "subscription" ? "Subscription payment prepared" : "One-off payment prepared",
          `${session.productId} requires ERC-7710 scoped payment permission before execution.`
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, { session, permission, timeline });
        return;
      }

      if (method === "POST" && (url.pathname === "/api/agent/premium-task" || url.pathname === "/api/agent/monitor")) {
        const body = await readJson<PremiumTaskBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const expectedMode: PaymentMode = url.pathname.endsWith("monitor") ? "subscription" : "one-off";
        if (isX402Configured()) {
          const x402Result = await processX402Request({ request, url });
          if (x402Result?.type === "payment-error" && x402Result.response) {
            applyX402HttpResult(response, x402Result);
            return;
          }
          if (x402Result?.type === "payment-verified") {
            const settlement = await settleX402Payment({ request, url, verified: x402Result });
            if (!settlement.ok) {
              throw new HttpError(402, "x402-settlement-failed", { error: settlement.error });
            }
            const sessions = store.paymentSessionsForCase(caseRecord.id);
            const session = body.paymentSessionId
              ? store.paymentSessions.get(body.paymentSessionId)
              : sessions.find((item) => item.mode === expectedMode);
            if (session && session.caseId === caseRecord.id) {
              const paid = markSessionPaid(session, settlement.transaction);
              store.paymentSessions.set(paid.id, paid);
            }
            const timeline = createTimelineEvent(
              caseRecord.id,
              "x402",
              expectedMode === "subscription" ? "Monitor paid via x402" : "Premium task paid via x402",
              "Facilitator settlement confirmed. Cleanup still requires a separate disclosure approval."
            );
            store.agentTimeline.set(timeline.id, timeline);
            sendJson(response, 200, {
              entitlement: "x402-settled",
              settlement,
              session,
              nextRequired: "explicit-cleanup-approval",
              timeline
            });
            return;
          }
        }
        const sessions = store.paymentSessionsForCase(caseRecord.id);
        const session = body.paymentSessionId
          ? store.paymentSessions.get(body.paymentSessionId)
          : sessions.find((item) => item.mode === expectedMode);
        if (!session || session.caseId !== caseRecord.id || session.mode !== expectedMode) {
          throw new HttpError(402, "x402-payment-required", {
            products: X402_PRODUCTS.filter((product) => product.mode === expectedMode),
            config: x402PublicConfig()
          });
        }
        const timeline = createTimelineEvent(
          caseRecord.id,
          "x402",
          expectedMode === "subscription" ? "Monitor entitlement checked" : "Premium task entitlement checked",
          "Payment session recorded. Configure live x402 or settle via PAYMENT-SIGNATURE for facilitator confirmation."
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 200, {
          entitlement: "payment-session-verified",
          session,
          nextRequired: "explicit-cleanup-approval",
          timeline
        });
        return;
      }

      if (
        method === "POST" &&
        (url.pathname === "/api/1shot/relay" || url.pathname === "/api/1shot/relay-demo")
      ) {
        if (!isOneShotConfigured()) {
          throw new HttpError(503, "oneshot-not-configured", {
            message: "Set ONESHOT_BASE_URL (default public relayer) and optional ONESHOT_API_KEY / ONESHOT_AUTHORIZATION."
          });
        }
        const body = await readJson<RelayerBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const relay = await relayOneShotForCase(body);
        relay.events.forEach((event) => store.relayerEvents.set(event.id, event));
        const timeline = createTimelineEvent(
          caseRecord.id,
          "1Shot",
          "Relayer status",
          `1Shot ${relay.mode} relay: ${relay.events.at(-1)?.status ?? "submitted"}`
        );
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, { mode: relay.mode, events: relay.events, timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/1shot/webhook") {
        const body = await readJson<RelayerBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const [event] = createRelayerEvents({
          caseId: caseRecord.id,
          sessionId: body.sessionId,
          permissionId: body.permissionId,
          status: body.status ?? "submitted",
          txHash: body.txHash,
          userOpHash: body.userOpHash,
          payload: sanitizeForLog(body.payload) as Record<string, unknown>
        }).slice(-1);
        store.relayerEvents.set(event.id, event);
        sendJson(response, 202, { event });
        return;
      }

      if (method === "GET" && url.pathname === "/api/agent/next") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, buildAgentNextStep(store, caseId));
        return;
      }

      if (method === "POST" && url.pathname === "/api/agent/chat") {
        const body = await readJson<{ caseId: string; message: string }>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        if (!body.message?.trim()) throw new HttpError(422, "agent-message-required");
        if (!isVeniceConfigured()) {
          throw new HttpError(503, "venice-not-configured", {
            message: "Set VENICE_API_KEY to enable the live agent."
          });
        }
        const plan = store.agentPlanForCase(caseRecord.id);
        const reply = await runVeniceAgentReply({
          caseId: caseRecord.id,
          message: body.message,
          planStep: plan?.currentStep,
          presetId: plan?.presetId
        });
        const timeline = createTimelineEvent(caseRecord.id, "Venice", "Agent reply", reply);
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 200, { reply, timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/agent/run-next") {
        const body = await readJson<AgentRunBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        sendJson(response, 200, await runCleanupAgentStep({
          store,
          caseRecord,
          trustCenterConfig: () => loadTrustCenterConfig(trustCenterPath)
        }));
        return;
      }

      if (await handleConnectorRoutes({
        request,
        response,
        method,
        url,
        store,
        trustCenterConfig: () => loadTrustCenterConfig(trustCenterPath)
      })) {
        return;
      }

      if (
        method === "POST" &&
        ["/api/ai/classify-case", "/api/ai/draft-request", "/api/ai/review-approval"].includes(url.pathname)
      ) {
        const body = await readJson<VeniceBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const kind =
          url.pathname === "/api/ai/draft-request"
            ? "draft-request"
            : url.pathname === "/api/ai/review-approval"
              ? "review-approval"
              : "classify-case";
        if (!isVeniceConfigured()) {
          throw new HttpError(503, "venice-not-configured", {
            message: "Set VENICE_API_KEY (and optional VENICE_BASE_URL, VENICE_MODEL) to enable Venice.ai."
          });
        }
        const analysis = await runVeniceAnalysis({
          caseId: caseRecord.id,
          kind,
          notes: body.notes,
          destination: body.destination,
          actionType: body.actionType
        });
        store.veniceAnalyses.set(analysis.id, analysis);
        const timeline = createTimelineEvent(caseRecord.id, "Venice", analysis.output.title, analysis.output.summary);
        store.agentTimeline.set(timeline.id, timeline);
        sendJson(response, 201, { analysis, timeline });
        return;
      }

      if (method === "POST" && url.pathname === "/api/agents/delegate") {
        const body = await readJson<AgentDelegateBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const result = createAgentDelegationSet(caseRecord.id);
        result.grants.forEach((grant) => store.permissionGrants.set(grant.id, grant));
        result.delegations.forEach((delegation) => store.agentDelegations.set(delegation.id, delegation));
        result.messages.forEach((message) => store.agentMessages.set(message.id, message));
        result.timeline.forEach((event) => store.agentTimeline.set(event.id, event));
        sendJson(response, 201, result);
        return;
      }

      if (method === "POST" && url.pathname === "/api/agents/message") {
        const body = await readJson<AgentMessageBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        if (!body.purpose) throw new HttpError(422, "message-purpose-required");
        const fromAgent = parseAgentName(body.fromAgent ?? "OblivionRoot");
        const toAgent = parseAgentName(body.toAgent ?? "VerifierAgent");
        const message = {
          id: `agent_msg_${crypto.randomUUID()}`,
          caseId: caseRecord.id,
          fromAgent,
          toAgent,
          purpose: redactText(body.purpose),
          redactedPayload: redactText(body.payload ?? ""),
          createdAt: new Date().toISOString()
        };
        store.agentMessages.set(message.id, message);
        sendJson(response, 201, { message });
        return;
      }

      if (method === "GET" && url.pathname === "/api/agents/timeline") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, {
          permissions: store.permissionGrantsForCase(caseId),
          payments: store.paymentSessionsForCase(caseId),
          relayerEvents: store.relayerEventsForCase(caseId),
          veniceAnalyses: store.veniceAnalysesForCase(caseId),
          delegations: store.agentDelegationsForCase(caseId),
          messages: store.agentMessagesForCase(caseId),
          timeline: store.agentTimelineForCase(caseId)
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/hackathon/status") {
        const caseId = url.searchParams.get("caseId");
        if (!caseId) throw new HttpError(422, "case-id-required");
        store.getCaseOrThrow(caseId);
        sendJson(response, 200, {
          status: buildHackathonStatusForCase(store, caseId)
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/export") {
        const body = await readJson<CaseBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        sendJson(response, 200, {
          exportedAt: new Date().toISOString(),
          case: caseRecord,
          approvals: store.approvalsForCase(caseRecord.id),
          actions: store.actionsForCase(caseRecord.id),
          exposures: store.exposuresForCase(caseRecord.id),
          sourceChecks: [...store.sourceChecks.values()].filter((sourceCheck) => sourceCheck.caseId === caseRecord.id),
          followUps: store.followUpsForCase(caseRecord.id),
          paymentSessions: store.paymentSessionsForCase(caseRecord.id),
          permissionGrants: store.permissionGrantsForCase(caseRecord.id),
          relayerEvents: store.relayerEventsForCase(caseRecord.id),
          veniceAnalyses: store.veniceAnalysesForCase(caseRecord.id),
          agentDelegations: store.agentDelegationsForCase(caseRecord.id),
          agentMessages: store.agentMessagesForCase(caseRecord.id),
          agentTimeline: store.agentTimelineForCase(caseRecord.id),
          agentPlan: store.agentPlanForCase(caseRecord.id) ?? null,
          connectorResults: store.connectorResultsForCase(caseRecord.id)
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/delete") {
        const body = await readJson<CaseBody>(request);
        const caseRecord = store.getCaseOrThrow(body.caseId);
        const deletedAt = new Date().toISOString();
        caseRecord.deletedAt = deletedAt;
        caseRecord.encryptedIntake = undefined;
        caseRecord.encryptedVaultPointer = "deleted";
        purgeCaseData(store, caseRecord.id);
        store.tombstones.set(caseRecord.id, deletedAt);
        sendJson(response, 200, { caseId: caseRecord.id, deletedAt, tombstone: true });
        return;
      }

      throw new HttpError(404, "not-found");
    } catch (error) {
      const httpError = toHttpError(error);
      sendJson(response, httpError.statusCode, {
        error: httpError.message,
        details: sanitizeForLog(httpError.details)
      });
    }
  }

  return {
    store,
    handler,
    server: createServer((request, response) => {
      void handler(request, response);
    })
  };
}

async function loadTrustCenterConfig(trustCenterPath: string): Promise<TrustCenterConfig> {
  const config = JSON.parse(await readFile(trustCenterPath, "utf8")) as TrustCenterConfig;
  return {
    ...config,
    attestationReportUrl: process.env.PHALA_ATTESTATION_URL ?? config.attestationReportUrl ?? null,
    phalaVerifierEndpoint: process.env.PHALA_VERIFIER_ENDPOINT ?? config.phalaVerifierEndpoint ?? null,
    maxAttestationAgeSeconds: Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? config.maxAttestationAgeSeconds ?? 600)
  };
}

function createCaseRecord(body: CreateCaseBody): CaseRecord {
  if (!["US", "EU", "UK"].includes(body.jurisdiction)) throw new HttpError(422, "unsupported-jurisdiction");
  if (!body.authorityBasis) throw new HttpError(422, "authority-basis-required");
  const now = new Date().toISOString();
  const id = `case_${crypto.randomUUID()}`;
  return {
    id,
    jurisdiction: body.jurisdiction,
    riskLevel: body.riskLevel ?? "standard",
    authorityBasis: body.authorityBasis,
    encryptedVaultPointer: `vault://${id}`,
    retentionDays: body.retentionDays ?? 90,
    createdAt: now,
    updatedAt: now
  };
}

function validateEncryptedBlob(blob: EncryptedBlob): void {
  if (!blob || blob.alg !== "AES-256-GCM" || !blob.keyId || !blob.nonce || !blob.ciphertext) {
    throw new HttpError(422, "valid-encrypted-intake-required");
  }
}

function sanitizeScope(scope: RedactedScope): RedactedScope {
  return {
    personLabel: redactText(scope.personLabel ?? "User"),
    aliases: (scope.aliases ?? []).map(redactText),
    approvedIdentifierLabels: (scope.approvedIdentifierLabels ?? []).map(redactText),
    sensitiveConstraints: (scope.sensitiveConstraints ?? []).map(redactText)
  };
}

function purgeCaseData(store: MemoryStore, caseId: string): void {
  for (const [id, approval] of store.approvals) {
    if (approval.caseId === caseId) store.approvals.delete(id);
  }
  for (const [id, action] of store.actions) {
    if (action.caseId === caseId) store.actions.delete(id);
  }
  for (const [id, exposure] of store.exposures) {
    if (exposure.caseId === caseId) store.exposures.delete(id);
  }
  for (const [id, sourceCheck] of store.sourceChecks) {
    if (sourceCheck.caseId === caseId) store.sourceChecks.delete(id);
  }
  for (const [id, followUp] of store.followUps) {
    if (followUp.caseId === caseId) store.followUps.delete(id);
  }
  for (const [id, session] of store.paymentSessions) {
    if (session.caseId === caseId) store.paymentSessions.delete(id);
  }
  for (const [id, grant] of store.permissionGrants) {
    if (grant.caseId === caseId) store.permissionGrants.delete(id);
  }
  for (const [id, event] of store.relayerEvents) {
    if (event.caseId === caseId) store.relayerEvents.delete(id);
  }
  for (const [id, analysis] of store.veniceAnalyses) {
    if (analysis.caseId === caseId) store.veniceAnalyses.delete(id);
  }
  for (const [id, delegation] of store.agentDelegations) {
    if (delegation.caseId === caseId) store.agentDelegations.delete(id);
  }
  for (const [id, message] of store.agentMessages) {
    if (message.caseId === caseId) store.agentMessages.delete(id);
  }
  for (const [id, event] of store.agentTimeline) {
    if (event.caseId === caseId) store.agentTimeline.delete(id);
  }
  for (const [id, plan] of store.agentPlans) {
    if (plan.caseId === caseId) store.agentPlans.delete(id);
  }
  for (const [id, result] of store.connectorResults) {
    if (result.caseId === caseId) store.connectorResults.delete(id);
  }
}

function parseAgentName(value: string): AgentName {
  const allowed: AgentName[] = ["OblivionRoot", "ScoutAgent", "DraftAgent", "VerifierAgent", "PaymentAgent", "SchedulerAgent"];
  if (!allowed.includes(value as AgentName)) throw new HttpError(422, "unsupported-agent");
  return value as AgentName;
}
