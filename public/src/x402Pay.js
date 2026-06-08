import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { ensureChain } from "./metamaskSmartAccount.js";

export const BASE_SEPOLIA_CHAIN = {
  chainIdHex: "0x14a34",
  chainId: 84532,
  addChainParams: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"]
  }
};

export const BASE_MAINNET_CHAIN = {
  chainIdHex: "0x2105",
  chainId: 8453,
  addChainParams: {
    chainId: "0x2105",
    chainName: "Base",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"]
  }
};

const CHAIN_BY_ID = {
  84532: { viemChain: baseSepolia, meta: BASE_SEPOLIA_CHAIN, rpcUrl: "https://sepolia.base.org" },
  8453: { viemChain: base, meta: BASE_MAINNET_CHAIN, rpcUrl: "https://mainnet.base.org" }
};

export function chainConfigFromX402Network(network) {
  const chainId = network?.startsWith("eip155:") ? Number(network.split(":")[1]) : 84532;
  const known = CHAIN_BY_ID[chainId];
  if (known) return { chainId, ...known };
  return { chainId, viemChain: baseSepolia, meta: BASE_SEPOLIA_CHAIN, rpcUrl: "https://sepolia.base.org" };
}

function buildHttpClient(provider, walletAddress, network) {
  const { viemChain, rpcUrl } = chainConfigFromX402Network(network);
  const walletClient = createWalletClient({
    account: walletAddress,
    chain: viemChain,
    transport: custom(provider)
  });
  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http(rpcUrl)
  });
  const signer = toClientEvmSigner(walletClient, publicClient);
  const coreClient = new x402Client();
  const chainId = network?.startsWith("eip155:") ? Number(network.split(":")[1]) : viemChain.id;
  registerExactEvmScheme(coreClient, {
    signer,
    networks: network ? [network] : undefined,
    schemeOptions: { [chainId]: { rpcUrl } }
  });
  return new x402HTTPClient(coreClient);
}

export function isLiveX402Ready(integrationsStatus) {
  return Boolean(integrationsStatus?.liveReady?.x402);
}

export async function settleAgentPayment({
  provider,
  walletAddress,
  endpoint,
  body,
  x402Config
}) {
  if (!provider?.request) throw Object.assign(new Error("wallet-provider-missing"), { error: "wallet-provider-missing" });
  if (!walletAddress) throw Object.assign(new Error("wallet-address-missing"), { error: "wallet-address-missing" });
  const network = x402Config?.network || "eip155:84532";
  const { meta } = chainConfigFromX402Network(network);
  await ensureChain(provider, meta);
  const httpClient = buildHttpClient(provider, walletAddress, network);
  const payload = JSON.stringify(body);

  const initial = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: payload
  });

  if (initial.status !== 402) {
    const json = await initial.json().catch(() => ({}));
    if (!initial.ok) throw json;
    return { settled: Boolean(json.entitlement === "x402-settled"), ...json };
  }

  const initialBody = await initial.json().catch(() => undefined);
  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paid = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...paymentHeaders
    },
    body: payload
  });

  const outcome = await httpClient.processResponse(paid);
  if (outcome.kind === "success") {
    return {
      settled: true,
      entitlement: "x402-settled",
      settlement: outcome.settleResponse,
      session: outcome.body?.session,
      timeline: outcome.body?.timeline
    };
  }
  if (outcome.kind === "settle_failed") {
    throw Object.assign(new Error("x402-settlement-failed"), {
      error: "x402-settlement-failed",
      detail: outcome.settleResponse
    });
  }
  if (outcome.kind === "payment_required") {
    throw Object.assign(new Error("x402-payment-still-required"), { error: "x402-payment-still-required" });
  }
  const errBody = outcome.body;
  throw Object.assign(new Error("x402-payment-failed"), { error: "x402-payment-failed", status: outcome.status, detail: errBody });
}

export function agentEndpointForMode(mode) {
  return mode === "subscription" ? "/api/credits/monitor" : "/api/credits/purchase";
}