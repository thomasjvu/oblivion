const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_HEX = "0xaa36a7";

export function sepoliaAddChainParams(infuraKey) {
  const rpc = infuraKey
    ? `https://sepolia.infura.io/v3/${infuraKey}`
    : "https://rpc.sepolia.org";
  return {
    chainId: SEPOLIA_HEX,
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: [rpc],
    blockExplorerUrls: ["https://sepolia.etherscan.io"]
  };
}

export async function ensureChain(provider, config) {
  const chainIdHex = config?.chainIdHex || SEPOLIA_HEX;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }]
    });
    return;
  } catch (error) {
    if (error?.code !== 4902) throw error;
  }
  const addParams = config?.addChainParams || sepoliaAddChainParams(config?.infuraKey);
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [addParams]
  });
}

export async function sendUpgradeBatch(provider, walletAddress, config) {
  const chainIdHex = config?.chainIdHex || SEPOLIA_HEX;
  await ensureChain(provider, config);
  const calls = [
    {
      to: walletAddress,
      value: "0x0"
    }
  ];
  const result = await provider.request({
    method: "wallet_sendCalls",
    params: [
      {
        version: "2.0.0",
        chainId: chainIdHex,
        from: walletAddress,
        calls,
        atomicRequired: true
      }
    ]
  });
  const id = typeof result === "string" ? result : result?.id;
  if (!id) throw new Error("MetaMask did not return a batch id for wallet_sendCalls.");
  return { callsId: id, chainId: config?.chainId || SEPOLIA_CHAIN_ID };
}

export async function pollCallsStatus(provider, callsId, options = {}) {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 1500;
  for (let i = 0; i < attempts; i += 1) {
    const status = await provider.request({
      method: "wallet_getCallsStatus",
      params: [callsId]
    });
    if (status?.status === "CONFIRMED" || status?.status === "success") {
      const txHash =
        status?.receipts?.[0]?.transactionHash ||
        status?.receipts?.[0]?.txHash ||
        status?.transactionHash;
      return { status: "confirmed", txHash, raw: status };
    }
    if (status?.status === "FAILED" || status?.status === "failure") {
      throw new Error("Smart account upgrade batch failed on chain.");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { status: "pending", txHash: undefined, raw: null };
}

export async function tryLiveSmartAccountUpgrade(provider, walletAddress, config) {
  if (!config?.liveEnabled) {
    return { ok: false, reason: "live-disabled" };
  }
  if (!provider?.request) {
    return { ok: false, reason: "no-provider" };
  }
  try {
    const sent = await sendUpgradeBatch(provider, walletAddress, config);
    const polled = await pollCallsStatus(provider, sent.callsId, config.poll);
    return {
      ok: true,
      mode: "live",
      callsId: sent.callsId,
      chainId: sent.chainId,
      txHash: polled.txHash,
      status: polled.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 4001 ? "user-rejected" : "upgrade-failed",
      message: error?.message || "Live MetaMask upgrade failed."
    };
  }
}