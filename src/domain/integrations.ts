import { DomainError } from "./errors.js";
import {
  deploymentEnvironment,
  deploymentProfile,
  type DeploymentEnvironment
} from "./deploymentEnv.js";

export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function envString(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function executorMode(): "record-only" | "live" {
  const raw = process.env.OBLIVION_EXECUTOR_MODE?.trim();
  if (raw === "live" || raw === "record-only") return raw;
  return deploymentProfile().executorMode;
}

export function disablePlaintextLogs(): boolean {
  const raw = process.env.OBLIVION_DISABLE_PLAINTEXT_LOGS?.trim();
  if (raw !== undefined && raw !== "") return envFlag("OBLIVION_DISABLE_PLAINTEXT_LOGS", false);
  return deploymentProfile().disablePlaintextLogs;
}

export function walletLiveMode(): boolean {
  const raw = process.env.WALLET_LIVE_MODE?.trim();
  if (raw !== undefined && raw !== "") return envFlag("WALLET_LIVE_MODE", false);
  return deploymentProfile().walletLiveMode;
}

export function persistenceStore(): "file" | "memory" | "sqlite" {
  const raw = process.env.OBLIVION_STORE?.trim();
  if (raw === "file" || raw === "memory" || raw === "sqlite") return raw;
  return deploymentProfile().persistenceStore;
}

function x402EnabledFlag(): boolean {
  const raw = process.env.X402_ENABLED?.trim();
  if (raw !== undefined && raw !== "") return envFlag("X402_ENABLED", true);
  return deploymentProfile().x402Enabled;
}

export function isLiveExecutorEnabled(): boolean {
  return executorMode() === "live";
}

export function isVeniceEnvConfigured(): boolean {
  return Boolean(envString("VENICE_API_KEY"));
}

export function isHibpConfigured(): boolean {
  return Boolean(envString("HIBP_API_KEY"));
}

export function isX402Configured(): boolean {
  if (!x402EnabledFlag()) return false;
  const payTo = envString("X402_PAY_TO");
  const facilitator = x402FacilitatorUrl();
  return Boolean(payTo && facilitator && payTo.startsWith("0x") && !/^0x0+$/i.test(payTo));
}

export function x402PayTo(): string {
  return envString("X402_PAY_TO");
}

export function x402FacilitatorUrl(): string {
  return envString("X402_FACILITATOR_URL", deploymentProfile().x402FacilitatorDefault);
}

export function x402Network(): string {
  return envString("X402_NETWORK", deploymentProfile().x402Network);
}

export function deploymentEnvironmentName(): DeploymentEnvironment {
  return deploymentEnvironment();
}

export type { DeploymentEnvironment };

export function isOneShotConfigured(): boolean {
  const raw = process.env.ONESHOT_BASE_URL;
  if (raw === undefined) return true;
  return Boolean(raw.trim());
}

export function oneShotBaseUrl(): string {
  return envString("ONESHOT_BASE_URL", "https://relayer.1shotapi.com/relayers");
}

export function isOneShotLiveReady(): boolean {
  return isOneShotConfigured() && Boolean(envString("ONESHOT_API_KEY"));
}

export function oblivionPublicApiUrl(): string {
  return envString("OBLIVION_PUBLIC_API_URL").replace(/\/$/, "");
}

export function oneShotWebhookDestinationUrl(
  caseId: string,
  sessionId?: string,
  webhookToken?: string
): string {
  const base = oblivionPublicApiUrl();
  if (!base) {
    throw new DomainError("oblivion-public-api-url-required", 503, {
      message: "Set OBLIVION_PUBLIC_API_URL to your public API origin for 1Shot webhooks."
    });
  }
  const params = new URLSearchParams({ caseId });
  if (sessionId) params.set("sessionId", sessionId);
  if (webhookToken) params.set("token", webhookToken);
  return `${base}/api/1shot/webhook?${params.toString()}`;
}

export function corsAllowedOrigin(): string {
  return envString("OBLIVION_CORS_ORIGIN");
}

export function isBraveSearchConfigured(): boolean {
  return Boolean(envString("BRAVE_SEARCH_API_KEY"));
}

export function isVeniceSearchConfigured(): boolean {
  return isVeniceEnvConfigured();
}

export function isDiscoverySearchConfigured(): boolean {
  return isVeniceSearchConfigured() || isBraveSearchConfigured();
}

export function braveSearchBaseUrl(): string {
  return envString("BRAVE_SEARCH_BASE_URL", "https://api.search.brave.com/res/v1/web/search");
}

export function braveSearchCount(): number {
  const raw = Number(process.env.BRAVE_SEARCH_COUNT || "20");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 30) : 20;
}