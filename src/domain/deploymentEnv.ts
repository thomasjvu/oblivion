import { isOneShotConfigured } from "./integrations.js";

export type DeploymentEnvironment = "development" | "production";

export interface DeploymentProfile {
  environment: DeploymentEnvironment;
  label: string;
  x402Network: string;
  x402FacilitatorDefault: string;
  walletChainId: number;
  walletChainName: string;
  walletRpcUrls: string[];
  walletBlockExplorerUrls: string[];
  executorMode: "record-only" | "live";
  disablePlaintextLogs: boolean;
  walletLiveMode: boolean;
  x402Enabled: boolean;
  persistenceStore: "file" | "memory";
}

const PROFILES: Record<DeploymentEnvironment, DeploymentProfile> = {
  development: {
    environment: "development",
    label: "Development (Sepolia testnets)",
    x402Network: "eip155:84532",
    x402FacilitatorDefault: "https://x402.org/facilitator",
    walletChainId: 11155111,
    walletChainName: "Sepolia",
    walletRpcUrls: ["https://rpc.sepolia.org"],
    walletBlockExplorerUrls: ["https://sepolia.etherscan.io"],
    executorMode: "record-only",
    disablePlaintextLogs: false,
    walletLiveMode: true,
    x402Enabled: true,
    persistenceStore: "file"
  },
  production: {
    environment: "production",
    label: "Production (Base mainnet)",
    x402Network: "eip155:8453",
    x402FacilitatorDefault: "https://api.cdp.coinbase.com/platform/v2/x402",
    walletChainId: 8453,
    walletChainName: "Base",
    walletRpcUrls: ["https://mainnet.base.org"],
    walletBlockExplorerUrls: ["https://basescan.org"],
    executorMode: "live",
    disablePlaintextLogs: true,
    walletLiveMode: true,
    x402Enabled: true,
    persistenceStore: "file"
  }
};

export function deploymentEnvironment(): DeploymentEnvironment {
  const raw = process.env.OBLIVION_DEPLOYMENT_ENV?.trim().toLowerCase();
  if (raw === "production" || raw === "prod" || raw === "mainnet") return "production";
  if (raw === "development" || raw === "dev" || raw === "sepolia" || raw === "testnet") {
    return "development";
  }
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function deploymentProfile(env = deploymentEnvironment()): DeploymentProfile {
  return PROFILES[env];
}

export function assertProductionSafety(): void {
  if (deploymentEnvironment() !== "production") return;
  const bypassFlags = [
    process.env.OBLIVION_CREDITS_BYPASS === "true" ? "OBLIVION_CREDITS_BYPASS" : null,
    process.env.OBLIVION_AI_BYPASS_PAYMENT === "true" ? "OBLIVION_AI_BYPASS_PAYMENT" : null
  ].filter(Boolean);
  if (bypassFlags.length > 0) {
    throw new Error(
      `Production deployment cannot start with payment bypass flags enabled: ${bypassFlags.join(", ")}`
    );
  }
  if (isOneShotConfigured()) {
    const webhookSecret =
      process.env.ONESHOT_WEBHOOK_SECRET?.trim() || process.env.ONESHOT_API_KEY?.trim();
    if (!webhookSecret) {
      throw new Error("Production deployment requires ONESHOT_WEBHOOK_SECRET or ONESHOT_API_KEY when 1Shot is configured");
    }
  }
}

export function walletChainId(): number {
  const override = process.env.WALLET_CHAIN_ID?.trim();
  if (override && Number.isFinite(Number(override))) return Number(override);
  return deploymentProfile().walletChainId;
}

export function walletChainConfig() {
  const profile = deploymentProfile();
  const chainId = walletChainId();
  const chainIdHex = `0x${chainId.toString(16)}`;
  const isBase = chainId === 8453 || chainId === 84532;
  const chainName =
    chainId === profile.walletChainId
      ? profile.walletChainName
      : chainId === 84532
        ? "Base Sepolia"
        : chainId === 8453
          ? "Base"
          : chainId === 11155111
            ? "Sepolia"
            : `Chain ${chainId}`;
  const rpcUrls =
    chainId === profile.walletChainId
      ? profile.walletRpcUrls
      : chainId === 84532
        ? ["https://sepolia.base.org"]
        : chainId === 8453
          ? ["https://mainnet.base.org"]
          : chainId === 11155111
            ? ["https://rpc.sepolia.org"]
            : profile.walletRpcUrls;
  const blockExplorerUrls =
    chainId === profile.walletChainId
      ? profile.walletBlockExplorerUrls
      : chainId === 84532
        ? ["https://sepolia.basescan.org"]
        : chainId === 8453
          ? ["https://basescan.org"]
          : chainId === 11155111
            ? ["https://sepolia.etherscan.io"]
            : profile.walletBlockExplorerUrls;
  return {
    chainId,
    chainIdHex,
    chainName,
    addChainParams: {
      chainId: chainIdHex,
      chainName,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls,
      blockExplorerUrls
    },
    rpcUrls,
    blockExplorerUrls
  };
}

export function x402ChainId(network = process.env.X402_NETWORK?.trim() || deploymentProfile().x402Network): number {
  if (!network.startsWith("eip155:")) return deploymentProfile().x402Network === "eip155:8453" ? 8453 : 84532;
  return Number(network.split(":")[1]);
}