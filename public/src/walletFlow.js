import { tryLiveSmartAccountUpgrade } from "./metamaskSmartAccount.js";
import { DEFAULT_WALLET_CONFIG } from "./walletLog.js";

export function shortenAddress(address) {
  if (!address || address.length < 12) return address || "Not connected";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function pickMetaMaskFromWindow(deps) {
  const eth = window.ethereum;
  if (!eth) return null;
  const list = eth.providers?.length ? eth.providers : eth.isMetaMask !== undefined ? [eth] : [];
  if (list.length) {
    const mm = list.find((p) => p.isMetaMask);
    if (mm) return mm;
    deps.walletLog.warn("No isMetaMask flag; multiple wallets may conflict", {
      count: list.length,
      names: list.map((p) => (p.isMetaMask ? "metamask" : "other"))
    });
  }
  if (eth.isMetaMask) return eth;
  return null;
}

export async function resolveEthereumProvider(state, deps, options = {}) {
  if (!options.forceFresh && state.ethereumProvider?.request) {
    deps.walletLog.info("Reusing cached provider", { isMetaMask: state.ethereumProvider.isMetaMask });
    return state.ethereumProvider;
  }
  const direct = pickMetaMaskFromWindow(deps);
  if (direct?.request) {
    deps.walletLog.info("Using window MetaMask provider", { isMetaMask: direct.isMetaMask });
    return direct;
  }
  const discovered = await new Promise((resolve) => {
    const providers = [];
    const onAnnounce = (event) => {
      providers.push(event.detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const preferred = providers.find((entry) => /metamask/i.test(entry?.info?.name || ""));
      deps.walletLog.info("EIP-6963 discovery", {
        total: providers.length,
        picked: preferred?.info?.name || providers[0]?.info?.name || "none"
      });
      resolve(preferred?.provider || providers[0]?.provider || null);
    }, 800);
  });
  if (discovered?.request) return discovered;
  deps.walletLog.warn("No injected provider — demo wallet fallback");
  return null;
}

export async function revokeWalletPermissions(provider, deps) {
  if (!provider?.request) return;
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }]
    });
    deps.walletLog.info("wallet_revokePermissions ok");
  } catch (error) {
    deps.walletLog.warn("wallet_revokePermissions skipped", { code: error?.code, message: error?.message });
  }
}

export async function requestWalletAccounts(provider, options = {}, deps) {
  if (!provider?.request) return [];
  if (options.pickAccount) {
    try {
      await provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch (error) {
      if (error?.code === 4001) throw error;
      deps?.walletLog?.warn("wallet_requestPermissions skipped", { code: error?.code, message: error?.message });
    }
  }
  return provider.request({ method: "eth_requestAccounts" });
}

export async function refreshWalletConfig(state, request, deps) {
  try {
    state.walletConfig = await request("/api/integrations/wallet-config");
    deps.walletLog.info(
      state.walletConfig.liveEnabled
        ? "Payments: Sepolia (WALLET_LIVE_MODE=true)"
        : "Payments: session mode (set WALLET_LIVE_MODE=true for Sepolia on-chain)",
      { chainId: state.walletConfig.chainId, liveEnabled: state.walletConfig.liveEnabled }
    );
  } catch (error) {
    state.walletConfig = { ...DEFAULT_WALLET_CONFIG };
    deps.walletLog.warn("wallet-config unavailable — using embedded defaults", {
      status: error?.error,
      hint: "Restart npm run dev if the server is an old build"
    });
  }
}

export async function ensureWalletProvider(state, deps, connectWalletFn) {
  if (!state.walletAddress) await connectWalletFn(state, { quiet: true, openHub: false }, deps);
  const provider = state.ethereumProvider || (await resolveEthereumProvider(state, deps));
  if (!provider?.request) throw { error: "no-provider", message: "Install MetaMask to settle x402 payments." };
  return provider;
}

export async function disconnectWallet(state, deps) {
  const provider = state.ethereumProvider || pickMetaMaskFromWindow(deps);
  await revokeWalletPermissions(provider, deps);
  state.walletAddress = "";
  state.smartAccountAddress = "";
  state.ethereumProvider = null;
  state.walletMode = "";
  state.walletCallsId = "";
  state.smartAccountTxHash = "";
  state.walletConnectError = "";
  state.walletConnectNote = "";
  state.walletPickAccount = true;
  deps.walletLog.info("disconnectWallet");
  deps.toggleWalletModal(false);
  deps.renderWalletPanels();
  deps.render();
}

export async function connectWallet(state, options, deps) {
  state.walletConnectError = "";
  state.walletConnectNote = "Opening MetaMask…";
  state.dockOpen = true;
  deps.renderWalletPanels();
  deps.walletLog.info("connectWallet start", { hasCase: deps.hasActiveCase(state) });
  let provider = null;
  const pickAccount = Boolean(state.walletPickAccount);
  state.walletPickAccount = false;
  try {
    provider = await resolveEthereumProvider(state, deps, { forceFresh: pickAccount });
    state.ethereumProvider = provider;
    if (provider?.request) {
      deps.walletLog.info("eth_requestAccounts", { pickAccount });
      const accounts = await requestWalletAccounts(provider, { pickAccount }, deps);
      state.walletAddress = accounts?.[0] || "";
      if (!state.walletAddress) {
        throw new Error("No account returned. Unlock MetaMask and try again.");
      }
      state.walletMode = provider.isMetaMask ? "metamask" : "injected";
      state.walletConnectNote = provider.isMetaMask
        ? `MetaMask connected ${shortenAddress(state.walletAddress)}`
        : `Wallet connected ${shortenAddress(state.walletAddress)}`;
      deps.walletLog.info("connected", { address: shortenAddress(state.walletAddress), isMetaMask: provider.isMetaMask });
    } else {
      throw Object.assign(new Error("MetaMask not detected"), {
        code: 4902,
        message: "Install MetaMask (or disable conflicting wallet extensions) and try again."
      });
    }
  } catch (error) {
    const code = error?.code;
    let message =
      code === 4001
        ? "Wallet connection cancelled in MetaMask."
        : error?.message || "Wallet connection failed.";
    if (/unexpected error/i.test(message) || error?.message?.includes("selectExtension")) {
      message =
        "Wallet extension conflict. Disable other wallet extensions (e.g. evmAsk) or pick MetaMask when prompted.";
    }
    state.walletConnectError = message;
    state.walletConnectNote = "";
    deps.walletLog.error("connect failed", { code, message: error?.message });
    deps.render();
    deps.write({ error: "wallet-connect-failed", message, code });
    throw error;
  }
  if (options.openHub) deps.openWalletHub();
  else deps.render();
  deps.$("#wallet-feedback-primary")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  await deps.syncWalletCases(state).catch(() => {});
  await deps.refreshCreditsBalance().catch(() => {});
  deps.write({
    walletAddress: state.walletAddress,
    mode: state.walletMode
  });
  return provider;
}

export async function createSmartAccount(state, options, deps) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start with the agent first — create a case, then enable Smart Account." };
  }
  if (!state.walletAddress) await connectWallet(state, { quiet: true }, deps);
  if (!state.walletConfig?.liveEnabled) {
    throw {
      error: "smart-account-live-required",
      message: "Smart Account requires WALLET_LIVE_MODE=true on the API server and MetaMask on Sepolia."
    };
  }
  const body = {
    caseId: state.currentCaseId,
    walletAddress: state.walletAddress,
    smartAccountAddress: options.smartAccountAddress || state.smartAccountAddress || state.walletAddress,
    txHash: options.txHash || state.smartAccountTxHash || undefined,
    callsId: options.callsId || state.walletCallsId || undefined,
    chainId: options.chainId || state.walletConfig?.chainId
  };
  const result = await deps.request("/api/metamask/smart-account-session", {
    method: "POST",
    body
  });
  state.smartAccountAddress = result.smartAccountAddress;
  state.walletMode = result.mode || "live";
  await deps.refreshHackathon({ silent: true, scope: deps.isHackathonMode(state) ? "checklist" : "agent" });
  if (!options.quiet) {
    const remaining = deps.hackathonPendingTracks(state);
    deps.addChat(
      "agent",
      remaining.length
        ? `Smart Account ready. Still pending: ${remaining.join(", ")} — use Developer details buttons below.`
        : "Smart Account ready. All sponsor tracks are complete."
    );
  }
  if (options.openHub !== false) deps.openWalletHub();
  else deps.render();
  deps.write(result);
  return result;
}

export async function enableSmartAccount(state, options, deps) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start a cleanup first, then enable Smart Account." };
  }
  if (!state.walletAddress) {
    await connectWallet(state, { quiet: true, openHub: false }, deps);
  }
  state.walletConnectNote = "Enabling Smart Account…";
  deps.renderWalletPanels();
  const provider = state.ethereumProvider || (await resolveEthereumProvider(state, deps));
  if (state.walletConfig?.liveEnabled && provider?.request) {
    state.walletConnectNote = "Confirm Sepolia Smart Account upgrade in MetaMask…";
    deps.renderWalletPanels();
    const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
    if (liveResult.ok) {
      state.walletCallsId = liveResult.callsId || "";
      state.smartAccountTxHash = liveResult.txHash || "";
      await createSmartAccount(state, {
        mode: "live",
        txHash: liveResult.txHash,
        callsId: liveResult.callsId,
        chainId: liveResult.chainId,
        quiet: options.quiet,
        openHub: options.openHub
      }, deps);
      if (!options.quiet) {
        deps.addChat(
          "agent",
          liveResult.txHash
            ? `Smart Account upgrade submitted (${shortenAddress(liveResult.txHash)}).`
            : "Smart Account upgrade sent — confirm in MetaMask if still pending."
        );
      }
      return;
    }
    if (liveResult.reason === "user-rejected") {
      state.walletConnectError = deps.paymentErrorMessage({ reason: "user-rejected", message: liveResult.message });
      deps.render();
      return;
    }
    state.walletConnectError =
      liveResult.message || "Live Smart Account upgrade failed. Confirm Sepolia batch in MetaMask.";
    deps.render();
    throw { error: "smart-account-live-required", message: state.walletConnectError };
  }
  state.walletConnectError = "Smart Account requires WALLET_LIVE_MODE=true and MetaMask on Sepolia.";
  deps.render();
  throw { error: "smart-account-live-required", message: state.walletConnectError };
}

export async function upgradeMetaMaskLive(state, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create a case first." };
  if (!state.walletAddress) await connectWallet(state, { quiet: true }, deps);
  const provider = state.ethereumProvider || (await resolveEthereumProvider(state, deps));
  if (!provider?.request) throw { error: "no-provider", message: "Install MetaMask to use live upgrade." };
  state.walletConnectNote = "Confirm Sepolia upgrade in MetaMask…";
  deps.renderWalletPanels();
  const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
  if (!liveResult.ok) {
    state.walletConnectError = liveResult.message || "Live upgrade failed.";
    deps.render();
    deps.write(liveResult);
    return;
  }
  state.walletCallsId = liveResult.callsId || "";
  state.smartAccountTxHash = liveResult.txHash || "";
  await createSmartAccount(state, {
    mode: "live",
    txHash: liveResult.txHash,
    callsId: liveResult.callsId,
    chainId: liveResult.chainId
  }, deps);
}