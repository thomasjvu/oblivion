import { pollRelayTask, submitRelayBundle } from "./oneShotRelayer.js";

export async function runVenice(state, kind, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const path = kind === "draft-request"
    ? "/api/ai/draft-request"
    : kind === "review-approval"
      ? "/api/ai/review-approval"
      : "/api/ai/classify-case";
  if (!state.walletAddress) await deps.connectWallet({ quiet: true, openHub: false });
  const result = await deps.request(path, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      walletAddress: state.walletAddress,
      notes: deps.$("#purpose").value || "Redacted people-search cleanup case.",
      destination: deps.$("#destination").value || "approved broker",
      actionType: state.actionType
    }
  });
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  state.tab = "settings";
  deps.render();
  deps.write(result);
}

export async function delegateAgents(state, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const result = await deps.request("/api/agents/delegate", {
    method: "POST",
    body: { caseId: state.currentCaseId }
  });
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  state.tab = "settings";
  deps.render();
  deps.write(result);
}

export async function relayPayment(state, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  await deps.refreshIntegrationsStatus().catch(() => {});
  if (!state.integrationsStatus?.liveReady?.oneShot) {
    throw {
      error: "oneshot-not-configured",
      message: "Set ONESHOT_API_KEY and OBLIVION_PUBLIC_API_URL on the API server for live 1Shot relay."
    };
  }
  const session =
    [...(state.agentContext?.payments || [])].find((item) => item.status === "paid" && item.mode === "one-off") ||
    [...(state.agentContext?.payments || [])].find((item) => item.status === "paid");
  if (!session) {
    throw { error: "payment-required", message: "Settle x402 payment before relaying via 1Shot." };
  }
  let result;
  if (session.relayerTaskId) {
    result = await pollRelayTask(state.currentCaseId, session.id, session.relayerTaskId);
  } else if (state.pendingRelayBundle?.method && state.pendingRelayBundle?.params) {
    result = await submitRelayBundle(
      state.currentCaseId,
      session.id,
      state.pendingRelayBundle.method,
      state.pendingRelayBundle.params,
      state.pendingRelayBundle.destinationUrl
    );
  } else {
    throw {
      error: "oneshot-relay-payload-required",
      message:
        "Provide a signed relayer_send7710Transaction bundle or an existing taskId. Poll again after submitting from the wallet flow."
    };
  }
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  state.tab = "settings";
  deps.addChat("agent", `1Shot relay: ${result.events?.at(-1)?.status || "submitted"}.`);
  deps.render();
  deps.write(result);
}

export async function askAgent(state, deps) {
  const text = deps.$("#agent-input").value.trim();
  if (!text) {
    deps.updateAgentSendState();
    return;
  }
  deps.addChat("user", text);
  deps.$("#agent-input").value = "";
  deps.updateAgentSendState();
  const lower = text.toLowerCase();
  if (deps.teeQuestionIntent(lower)) {
    deps.addChat("agent", await deps.buildTeeVerificationBrief());
    state.tab = "trust";
    deps.render();
    return;
  }
  if (!state.currentCaseId) {
    if (!text) {
      deps.addChat("agent", "Describe what to clean up in one sentence — here or in the intake box.");
      deps.render();
      return;
    }
    const intake = deps.$("#agent-intake");
    if (intake) intake.value = text;
    deps.renderIntakeInferencePreview();
    await deps.startWithAgent();
    return;
  }
  if (lower.includes("run") || lower.includes("do it") || lower.includes("continue")) {
    try {
      deps.assertCaseActivatedClient();
      await agentAutopilot(state, {}, deps);
    } catch (error) {
      if (error?.error === "case-activation-required") {
        deps.addChat("agent", error.message);
        deps.render();
        return;
      }
      throw error;
    }
    return;
  }
  if (lower.includes("disclosure") || lower.includes("explain")) {
    deps.$("#agent-explain-disclosure").click();
    return;
  }
  if (state.integrationsStatus?.liveReady?.venice) {
    try {
      if (!state.walletAddress) await deps.connectWallet({ quiet: true, openHub: false });
      const result = await deps.request("/api/agent/chat", {
        method: "POST",
        body: {
          caseId: state.currentCaseId,
          walletAddress: state.walletAddress,
          message: text || "What should I do next?"
        }
      });
      deps.addChat("agent", result.reply || "No reply.");
      await deps.refreshCaseContext({ silent: true, scope: "agent" });
      deps.render();
      return;
    } catch (error) {
      if (error?.error === "credits-insufficient" || error?.error === "ai-payment-required") {
        deps.addChat(
          "agent",
          "Insufficient wallet credits for Venice AI — buy 500 credits ($5) or subscribe for 1,200/month in Settings → Payment rails."
        );
        deps.openPaymentRails();
        deps.render();
        return;
      }
      deps.addChat("agent", error?.message || "Venice request failed.");
      deps.render();
      return;
    }
  }
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  const next = state.agentNext;
  deps.addChat("agent", next ? `${deps.shortStepTitle(next.title)}. ${next.message || ""}`.trim() : "Set VENICE_API_KEY on the server for live agent replies.");
  deps.render();
}

export async function agentRunNext(state, options, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  deps.assertCaseActivatedClient({ quiet: options.quiet });
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  if (state.agentNext?.action === "select-preset") {
    await deps.startPreset({ quiet: true });
    await deps.refreshCaseContext({ silent: true, scope: "agent" });
  }
  if (state.agentNext?.action === "request-approval" && state.currentStatus?.approvalsNeeded?.length > 0) {
    deps.addChat("agent", "Approval required. Review the card.");
    state.tab = "overview";
    deps.render();
    return;
  }
  if (deps.peopleSearchPresetActive() && deps.needsExposureDiscovery()) {
    const discovery = await deps.maybeAutoDiscoverFindings({ quiet: true });
    await deps.refreshCaseContext({ silent: true, scope: "agent" });
    await deps.syncCurrentCaseStatus();
    if (discovery.reason === "urls-needed") {
      if (!options.quiet) {
        deps.openFindingsPastePanel();
        deps.addChat("agent", "Paste profile URLs under Exposure links, then run the next step again.");
      }
      state.tab = "overview";
      deps.render();
      return;
    }
  }
  const pendingFindings = state.currentStatus?.pendingFindings?.length ?? 0;
  if (
    pendingFindings > 0 ||
    state.agentNext?.action === "confirm-matches" ||
    state.agentNext?.blockedReasons?.includes("candidate-confirmation-needed")
  ) {
    if (!options.quiet) {
      deps.addChat("agent", "Review Exposure links — confirm yours or mark Not me.");
      deps.openFindingsPastePanel();
    }
    state.tab = "overview";
    deps.render();
    return;
  }
  const blocked = state.agentNext?.blockedReasons || [];
  if (blocked.includes("discovery-needed")) {
    if (!options.quiet) {
      deps.openFindingsPastePanel();
      deps.addChat("agent", state.agentNext?.message || "Paste profile URLs to discover listings.");
    }
    state.tab = "overview";
    deps.render();
    return;
  }
  if (blocked.length) {
    if (!options.quiet) deps.addChat("agent", state.agentNext.message || "Paused for review.");
    state.tab = "overview";
    deps.render();
    return;
  }
  if (state.agentNext?.action === "complete") {
    deps.addChat("agent", "Cleanup cycle complete. Open the Trust tab for proof details.");
    deps.render();
    return;
  }
  const result = await deps.request(`/api/cases/${state.currentCaseId}/agent/run`, {
    method: "POST",
    body: {
      highAutonomy: deps.$("#high-autonomy-toggle").checked
    }
  });
  if (result.caseStatus) state.currentStatus = result.caseStatus;
  if (result.plan) state.agentPlan = result.plan;
  if (result.connectorResults) state.connectorResults = result.connectorResults;
  await deps.refreshAgentPlan({ silent: true }).catch(() => {});
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  await deps.syncCurrentCaseStatus();
  if (!options.quiet) deps.addChat("agent", `${deps.shortStepTitle(result.ran.title)}. Next: ${deps.shortStepTitle(result.next.title)}.`);
  deps.render();
  deps.write(result);
}

export async function agentAutopilot(state, options, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  deps.assertCaseActivatedClient({ quiet: options.silentUser });
  if (!options.silentUser) deps.addChat("user", "Run route.");
  for (let index = 0; index < 12; index += 1) {
    await deps.refreshCaseContext({ silent: true, scope: "agent" });
    const pending = state.currentStatus?.pendingFindings?.length ?? 0;
    const blocked = state.agentNext?.blockedReasons || [];
    if (
      state.agentNext?.action === "complete" ||
      (state.agentNext?.action === "request-approval" && state.currentStatus?.approvalsNeeded?.length > 0) ||
      pending > 0 ||
      state.agentNext?.action === "confirm-matches" ||
      blocked.includes("candidate-confirmation-needed") ||
      (blocked.length > 0 && !blocked.includes("discovery-needed"))
    ) {
      break;
    }
    await agentRunNext(state, { quiet: true }, deps);
  }
  await deps.refreshCaseContext({ silent: true, scope: "agent" });
  await deps.refreshAgentPlan({ silent: true }).catch(() => {});
  await deps.syncCurrentCaseStatus();
  deps.addChat("agent", state.agentNext?.action === "request-approval"
    ? "Approval required."
    : state.agentNext?.action === "complete"
      ? "Complete. No external submission."
      : state.agentNext?.blockedReasons?.length
        ? state.agentNext.message || "Paused for review."
      : "Paused for review.");
  state.tab = "overview";
  deps.render();
}