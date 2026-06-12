import { agentEndpointForMode, isLiveX402Ready, settleAgentPayment } from "./x402Gate.js";
import { connectWallet, createSmartAccount, enableSmartAccount, ensureWalletProvider } from "./walletFlow.js";

export function paymentPlanLabel(mode) {
  return mode === "subscription" ? "Monitor subscription ($10 USDC/mo)" : "Starter credits ($5 USDC)";
}

export function hasEntitledPayment(state, mode) {
  const sessions = state.hackathon?.payments || [];
  return sessions.some((session) => session.mode === mode && session.status === "paid");
}

export function hasSubscriptionEntitlement(state) {
  return hasEntitledPayment(state, "subscription") || state.aiEntitlement?.mode === "subscription";
}

export function caseIsActivated(state) {
  if (state.currentStatus?.activated) return true;
  return hasEntitledPayment(state, state.selectedPaymentMode || "one-off");
}

export async function refreshIntegrationsStatus(state, request) {
  try {
    state.integrationsStatus = await request("/api/integrations/status");
    if (isLiveX402Ready(state.integrationsStatus)) state.paymentRailsNotice = "";
  } catch {
    state.integrationsStatus = null;
  }
  try {
    state.x402Config = await request("/api/x402/config");
  } catch {
    state.x402Config = null;
  }
}

export async function settlePaymentForMode(state, mode, options, deps) {
  if (!isLiveX402Ready(state.integrationsStatus)) {
    state.paymentRailsNotice =
      "x402 is not configured on the API server — settlement was skipped. Set X402_PAY_TO and redeploy.";
    deps.renderPayments();
    return { settled: false, skipped: true, reason: "x402-not-configured" };
  }
  state.paymentRailsNotice = "";
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const sessions = state.hackathon?.payments || [];
  const session = sessions.find((item) => item.productId === (mode === "subscription" ? "credit-monitor" : "credit-starter"));
  if (!session) throw { error: "payment-session-missing", message: "Prepare payment first." };
  if (session.status === "paid") return { settled: true, alreadyPaid: true, session };
  const provider = await ensureWalletProvider(state, deps.walletDeps, (s, o, d) => connectWallet(s, o, d));
  if (!options.quiet) {
    state.walletConnectNote = `Confirm ${paymentPlanLabel(mode)} USDC on Base Sepolia in MetaMask…`;
    deps.walletDeps.renderWalletPanels();
  }
  const result = await settleAgentPayment({
    provider,
    walletAddress: state.walletAddress,
    endpoint: agentEndpointForMode(mode),
    body: {
      caseId: state.currentCaseId,
      paymentSessionId: session.id,
      walletAddress: state.walletAddress
    },
    x402Config: state.x402Config
  });
  await deps.refreshHackathon({ silent: true, scope: "agent" });
  return result;
}

export async function preparePayment(state, mode, options, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!state.walletAddress) await connectWallet(state, { quiet: true, openHub: false }, deps.walletDeps);
  if (!state.smartAccountAddress) await createSmartAccount(state, { quiet: true, openHub: false }, deps.walletDeps);
  await refreshIntegrationsStatus(state, deps.request).catch(() => {});
  if (!isLiveX402Ready(state.integrationsStatus)) {
    state.paymentRailsNotice =
      "x402 is not configured on the API server — only a payment-required session was created.";
    deps.renderPayments();
  }
  const productId = mode === "subscription" ? "credit-monitor" : "credit-starter";
  const result = await deps.request(`/api/x402/${mode === "subscription" ? "subscription" : "one-off"}`, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      productId,
      walletAddress: state.walletAddress,
      smartAccountAddress: state.smartAccountAddress
    }
  });
  await deps.refreshHackathon({ silent: true, scope: "agent" });
  let settlement = null;
  if (!options.skipSettle && isLiveX402Ready(state.integrationsStatus)) {
    try {
      settlement = await settlePaymentForMode(state, mode, { quiet: options.quiet }, deps);
    } catch (error) {
      const message = deps.paymentErrorMessage(error);
      if (options.statusEl) {
        deps.setInlineStatus(options.statusEl, message, {
          baseClass: "muted small onboarding-payment-status",
          variant: deps.isUserRejectedError(error) ? "warning" : "fail"
        });
      }
      if (!options.quiet) {
        state.walletConnectError = message;
        deps.addChat("agent", message);
        throw error;
      }
    }
  }
  deps.renderSubscriptionUpsell();
  if (!options.quiet) deps.openPaymentRails();
  deps.write({ ...result, settlement });
  return { ...result, settlement };
}

export async function ensureCasePayment(state, options, deps) {
  const mode = state.selectedPaymentMode || "one-off";
  const statusEl = options.statusEl || deps.$("#onboarding-payment-status");
  if (!state.walletAddress) {
    if (statusEl) {
      deps.setInlineStatus(statusEl, "Connect MetaMask to pay for this cleanup…", {
        baseClass: "muted small onboarding-payment-status"
      });
    }
    if (!options.quiet) {
      deps.addChat("agent", "Approve the MetaMask connection to pay for this cleanup.");
    }
    await connectWallet(state, { openHub: false }, deps.walletDeps);
  }
  await deps.refreshHackathon({ silent: true, scope: "all" }).catch(() => {});
  if (hasEntitledPayment(state, mode)) {
    if (statusEl) {
      deps.setInlineStatus(statusEl, `${paymentPlanLabel(mode)} is active for this case.`, {
        baseClass: "muted small onboarding-payment-status",
        variant: "success"
      });
    }
    return { ok: true, mode, alreadyPaid: true };
  }
  const liveX402 = isLiveX402Ready(state.integrationsStatus);
  if (statusEl) {
    deps.setInlineStatus(
      statusEl,
      liveX402
        ? `Confirm ${paymentPlanLabel(mode)} USDC on Base Sepolia in MetaMask…`
        : `Confirm ${paymentPlanLabel(mode)} in MetaMask…`,
      { baseClass: "muted small onboarding-payment-status" }
    );
  }
  if (!state.smartAccountAddress) {
    await enableSmartAccount(state, { quiet: true, openHub: false }, deps.walletDeps).catch(() =>
      createSmartAccount(state, { quiet: true, openHub: false }, deps.walletDeps)
    );
  }
  await preparePayment(state, mode, { quiet: true, skipSettle: false, statusEl }, deps);
  await deps.refreshHackathon({ silent: true, scope: "products" }).catch(() => {});
  if (statusEl) {
    deps.setInlineStatus(
      statusEl,
      hasEntitledPayment(state, mode)
        ? `${paymentPlanLabel(mode)} confirmed — agent AI unlocked for this case.`
        : liveX402
          ? "Payment not confirmed. Open Settings → Payment rails and tap Pay once / Subscribe."
          : "Payment session prepared. Open Settings → Payment rails if MetaMask did not confirm.",
      {
        baseClass: "muted small onboarding-payment-status",
        variant: hasEntitledPayment(state, mode) ? "success" : undefined
      }
    );
  }
  if (!options.quiet) {
    deps.addChat(
      "agent",
      hasEntitledPayment(state, mode)
        ? `${paymentPlanLabel(mode)} is set for this case. I'll still pause for your approval before anything sends.`
        : liveX402
          ? "Confirm USDC payment in MetaMask on Base Sepolia, or finish in Settings → Payment rails."
          : "Finish payment in Settings → Payment rails if MetaMask did not confirm."
    );
  }
  deps.renderSubscriptionUpsell();
  const paid = hasEntitledPayment(state, mode);
  const result = { ok: paid, mode, alreadyPaid: paid, paymentRequired: !paid };
  if (!paid) {
    const message = liveX402
      ? "Payment not confirmed. Open Settings → Payment rails and settle USDC on Base Sepolia."
      : "x402 is not configured on the server — payment cannot be settled until X402_PAY_TO is set.";
    if (!options.quiet) {
      throw { error: "payment-not-confirmed", message };
    }
  }
  return result;
}