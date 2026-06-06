export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function envString(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function executorMode(): "record-only" | "live" {
  return envString("OBLIVION_EXECUTOR_MODE", "record-only") === "live" ? "live" : "record-only";
}

export function isLiveExecutorEnabled(): boolean {
  return executorMode() === "live";
}

export function isVeniceEnvConfigured(): boolean {
  return Boolean(envString("VENICE_API_KEY"));
}

export function veniceDemoFallbackEnabled(): boolean {
  return envFlag("VENICE_DEMO_FALLBACK", process.env.NODE_ENV !== "production");
}

export function isHibpConfigured(): boolean {
  return Boolean(envString("HIBP_API_KEY"));
}

export function isX402Configured(): boolean {
  if (!envFlag("X402_ENABLED", true)) return false;
  const payTo = envString("X402_PAY_TO");
  const facilitator = envString("X402_FACILITATOR_URL", "https://x402.org/facilitator");
  return Boolean(payTo && facilitator && payTo.startsWith("0x"));
}

export function x402PayTo(): string {
  return envString("X402_PAY_TO");
}

export function x402FacilitatorUrl(): string {
  return envString("X402_FACILITATOR_URL", "https://x402.org/facilitator");
}

export function x402Network(): string {
  return envString("X402_NETWORK", "eip155:84532");
}

export function isOneShotConfigured(): boolean {
  const raw = process.env.ONESHOT_BASE_URL;
  if (raw === undefined) return true;
  return Boolean(raw.trim());
}

export function oneShotBaseUrl(): string {
  return envString("ONESHOT_BASE_URL", "https://relayer.1shotapi.com/relayers");
}

export function oneShotDemoFallbackEnabled(): boolean {
  return envFlag("ONESHOT_DEMO_FALLBACK", false);
}

export function isOneShotLiveReady(): boolean {
  return isOneShotConfigured() && Boolean(envString("ONESHOT_API_KEY")) && !oneShotDemoFallbackEnabled();
}

export function isBraveSearchConfigured(): boolean {
  return Boolean(envString("BRAVE_SEARCH_API_KEY"));
}

export function braveSearchBaseUrl(): string {
  return envString("BRAVE_SEARCH_BASE_URL", "https://api.search.brave.com/res/v1/web/search");
}

export function braveSearchCount(): number {
  const raw = Number(process.env.BRAVE_SEARCH_COUNT || "20");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 30) : 20;
}