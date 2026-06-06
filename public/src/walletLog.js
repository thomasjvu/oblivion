const MAX = 24;

export function createWalletLogger(onUpdate) {
  const entries = [];

  function push(level, message, detail) {
    const row = {
      ts: new Date().toISOString().slice(11, 19),
      level,
      message,
      detail: detail ? JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""
    };
    entries.unshift(row);
    if (entries.length > MAX) entries.length = MAX;
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[oblivion:wallet] ${message}`, detail ?? "");
    onUpdate?.(entries);
    return row;
  }

  return {
    entries: () => entries,
    info: (message, detail) => push("info", message, detail),
    warn: (message, detail) => push("warn", message, detail),
    error: (message, detail) => push("error", message, detail)
  };
}

export const DEFAULT_WALLET_CONFIG = {
  mode: "demo",
  liveEnabled: false,
  chainId: 11155111,
  chainIdHex: "0xaa36a7",
  addChainParams: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"]
  },
  poll: { attempts: 12, delayMs: 1500 }
};