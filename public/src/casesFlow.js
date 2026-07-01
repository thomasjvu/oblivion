import * as Vault from "./crypto.js";
import { redactedScopeFromIntake } from "./intakeScope.js";
import { removeCaseToken } from "./apiClient.js";
import { caseIsActivated } from "./paymentsFlow.js";

export function saveLocalCases(state, { getCaseToken, setCaseToken }) {
  const summaries = state.cases.map((item) => ({
    id: item.id,
    jurisdiction: item.jurisdiction,
    riskLevel: item.riskLevel,
    authorityBasis: item.authorityBasis,
    redactedScope: item.redactedScope,
    updatedAt: item.updatedAt
  }));
  localStorage.setItem("oblivion.caseSummaries", JSON.stringify(summaries));
  for (const item of state.cases) {
    const token = getCaseToken(item.id) || item.accessToken;
    if (token) setCaseToken(item.id, token);
  }
  if (state.currentCaseId) localStorage.setItem("oblivion.currentCaseId", state.currentCaseId);
}

export function loadLocalCases({ getCaseToken, setCaseToken }) {
  try {
    const summaries = JSON.parse(localStorage.getItem("oblivion.caseSummaries") || "[]");
    for (const item of summaries) {
      if (item.accessToken) setCaseToken(item.id, item.accessToken);
    }
    return summaries.map(({ accessToken: _token, ...summary }) => summary);
  } catch {
    return [];
  }
}

export async function refreshCases(state, deps) {
  state.cases = loadLocalCases(deps.tokenDeps);
  if (state.appOpen && state.currentCaseId) {
    await loadCase(state, state.currentCaseId, { silent: true, openApp: false }, deps);
  } else {
    await deps.refreshAgentPlan({ silent: true }).catch(() => {});
    await deps.refreshCaseContext({ silent: true }).catch(() => {});
    deps.render();
  }
}

export async function loadCase(state, caseId, options, deps) {
  if (options.openApp !== false) {
    state.appOpen = true;
    state.dockOpen = true;
    state.dockPinned = true;
    location.hash = "app";
  }
  state.currentCaseId = caseId;
  localStorage.setItem("oblivion.currentCaseId", caseId);
  try {
    const loaded = await deps.request(`/api/cases/${caseId}`);
    state.currentStatus = loaded.status;
    const index = state.cases.findIndex((item) => item.id === caseId);
    const summary = { ...loaded.case, status: loaded.status };
    if (index >= 0) state.cases[index] = summary;
    else state.cases.unshift(summary);
    saveLocalCases(state, deps.tokenDeps);
    if (!options.silent) deps.write(loaded);
    await deps.refreshAgentPlan({ silent: true }).catch(() => {});
    await deps.refreshCaseContext({ silent: true }).catch(() => {});
    state.onboardingPreviewReady = false;
    if (state.currentStatus && !caseIsActivated(state)) {
      state.preSearchReady = false;
      deps.resetPreSearchUi();
    }
  } catch (error) {
    state.currentStatus = null;
    if (error?.error === "case-not-found") {
      state.cases = state.cases.filter((item) => item.id !== caseId);
      state.currentCaseId = "";
      localStorage.removeItem("oblivion.currentCaseId");
      saveLocalCases(state, deps.tokenDeps);
      const replacement = state.appOpen ? state.cases[0] : null;
      if (replacement) {
        await loadCase(state, replacement.id, { silent: options.silent }, deps);
        return;
      }
    }
    if (!options.silent) deps.write(error);
  }
  deps.updateSessionHandoffWarning();
  deps.render();
}

export async function createCase(state, options, deps) {
  state.appOpen = true;
  state.dockOpen = true;
  location.hash = "app";
  if (!state.walletAddress) {
    await deps.connectWallet({ openHub: false });
  }
  if (!state.walletAddress) {
    throw { error: "wallet-required", message: "Connect MetaMask to start cleanup." };
  }
  const parsed = options.parsed
    ? { ...options.parsed }
    : deps.parseIntakeForCase(options.intakeText ?? deps.$("#agent-intake")?.value ?? deps.$("#intake")?.value ?? "");
  if (!parsed.intakeText) {
    throw { error: "intake-required", message: "Enter your name to continue." };
  }
  deps.applyParsedIntakeToForm(parsed);

  state.operatorEmailRelay = deps.$("#operator-email-relay")?.checked !== false;
  state.contactEmail = deps.$("#contact-email")?.value?.trim() || "";
  const created = await deps.request("/api/cases", {
    method: "POST",
    body: {
      jurisdiction: parsed.jurisdiction,
      authorityBasis: parsed.authorityBasis,
      riskLevel: parsed.riskLevel,
      casePreferences: { operatorEmailRelay: state.operatorEmailRelay }
    }
  });
  const caseId = created.case.id;
  if (created.accessToken) deps.tokenDeps.setCaseToken(caseId, created.accessToken);
  const intakeText = parsed.intakeText;
  if (!state.vaultKey) state.vaultKey = await Vault.createVaultKey();
  const encryptedIntake = await Vault.encryptPayload(
    state.vaultKey,
    {
      legalName: parsed.personLabel,
      cityState: parsed.region || undefined,
      aliases: parsed.aliases ?? [],
      notes: intakeText,
      contactEmail: state.contactEmail || undefined
    },
    caseId
  );
  const intake = await deps.request(`/api/cases/${caseId}/intake`, {
    method: "POST",
    body: {
      encryptedIntake,
      redactedScope: redactedScopeFromIntake(parsed)
    }
  });
  state.currentCaseId = caseId;
  localStorage.setItem("oblivion.currentCaseId", caseId);
  state.currentStatus = intake.status ?? state.currentStatus;
  if (!state.currentStatus?.activated) {
    await deps.syncCurrentCaseStatus();
  }
  state.cases.unshift({ ...intake.case, status: state.currentStatus });
  saveLocalCases(state, deps.tokenDeps);
  const previewUrlsHandoff = [...new Set([...(options.pastedUrls ?? []), ...(options.previewUrls ?? state.onboardingPreviewUrls ?? [])])];
  if (previewUrlsHandoff.length) {
    localStorage.setItem(`oblivion.discoveryUrls.${caseId}`, JSON.stringify(previewUrlsHandoff));
  }
  deps.syncPaymentPlanFromForm();
  try {
    await deps.ensureCasePayment({ quiet: false, statusEl: deps.$("#onboarding-payment-status") });
  } catch (error) {
    await deps.syncCurrentCaseStatus();
    if (!caseIsActivated(state)) throw error;
  }
  if (!caseIsActivated(state)) {
    throw {
      error: "case-activation-required",
      message: "Buy credits for this case to continue cleanup."
    };
  }
  state.agentPlan = null;
  state.connectorResults = [];
  state.intakeText = intakeText;
  deps.updateSessionHandoffWarning();
  const inferredPreset = deps.recommendPreset({
    jurisdiction: intake.case.jurisdiction,
    riskLevel: intake.case.riskLevel,
    intakeText
  });
  state.recommendedPresetId = options.presetId || inferredPreset;
  state.selectedPresetId = options.presetId || inferredPreset;
  state.showRouteTab = false;
  state.tab = "overview";
  state.dockOpen = true;
  deps.addChat("user", parsed.personLabel || intakeText);
  if (options.autoStartRoute) {
    await deps.startPreset({ quiet: true });
    const previewUrls = options.previewUrls ?? state.onboardingPreviewUrls ?? [];
    const pastedUrls = [...new Set([...(options.pastedUrls ?? []), ...previewUrls])];
    const searchLabels = parsed.personLabel
      ? {
          personLabel: parsed.personLabel,
          aliases: parsed.aliases ?? [],
          regionLabel: parsed.region || undefined
        }
      : undefined;
    if (pastedUrls.length) {
      if (deps.$("#findings-paste-input")) {
        deps.$("#findings-paste-input").value = pastedUrls.join("\n");
      }
      localStorage.setItem(`oblivion.discoveryUrls.${caseId}`, JSON.stringify(pastedUrls));
    }
    const discoverOpts = { force: true, quiet: true, searchLabels };
    if (pastedUrls.length) discoverOpts.pastedUrls = pastedUrls;
    await deps.maybeAutoDiscoverFindings(discoverOpts).catch(() => {});
    await deps.syncCurrentCaseStatus();
    state.onboardingPreviewUrls = [];
    state.autopilotBusy = true;
    deps.render();
    await deps.agentAutopilot({ silentUser: true }).catch(() => {});
    state.autopilotBusy = false;
    deps.addChat("agent", `Running ${deps.presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
  } else {
    deps.addChat("agent", `Ready — ${deps.presetTitle(state.selectedPresetId)}. Tap Next.`);
  }
  if (state.walletAddress) {
    await linkCurrentCaseToWallet(state, deps).catch(() => {});
    await syncWalletCases(state, deps).catch(() => {});
  }
  saveLocalCases(state, deps.tokenDeps);
  deps.render();
  deps.write(intake);
}

export async function linkCurrentCaseToWallet(state, deps, caseId = state.currentCaseId) {
  if (!state.walletAddress || !caseId) return;
  await deps.request("/api/wallet/cases/link", {
    method: "POST",
    body: { caseId, walletAddress: state.walletAddress }
  });
}

export async function syncWalletCases(state, deps) {
  if (!state.walletAddress) return;
  const result = await deps.request(
    `/api/wallet/cases?walletAddress=${encodeURIComponent(state.walletAddress)}`
  );
  const remote = result.cases || [];
  const byId = new Map(state.cases.map((item) => [item.id, item]));
  for (const item of remote) {
    if (!byId.has(item.id) && deps.tokenDeps.getCaseToken(item.id)) {
      byId.set(item.id, {
        id: item.id,
        jurisdiction: item.jurisdiction,
        redactedScope: item.personLabel ? { personLabel: item.personLabel } : undefined,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt
      });
    } else if (byId.has(item.id)) {
      const existing = byId.get(item.id);
      byId.set(item.id, {
        ...existing,
        redactedScope: existing.redactedScope || (item.personLabel ? { personLabel: item.personLabel } : undefined),
        updatedAt: item.updatedAt || existing.updatedAt
      });
    }
  }
  state.cases = [...byId.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  saveLocalCases(state, deps.tokenDeps);
}

export async function deleteCaseById(state, caseId, options, deps) {
  if (!caseId) throw { error: "case-required", message: "Select a case." };
  if (!options.skipConfirm) {
    deps.openDeleteCaseModal(caseId);
    return;
  }
  const deleted = await deps.request("/api/delete", {
    method: "POST",
    body: { caseId }
  });
  state.cases = state.cases.filter((item) => item.id !== caseId);
  removeCaseToken(caseId);
  if (state.currentCaseId === caseId) {
    state.currentCaseId = "";
    state.currentStatus = null;
    state.vaultKey = null;
    state.agentPlan = null;
    state.connectorResults = [];
    state.tab = "overview";
    localStorage.removeItem("oblivion.currentCaseId");
  }
  saveLocalCases(state, deps.tokenDeps);
  deps.closeDeleteCaseModal();
  deps.render();
  deps.write(deleted);
}

export async function confirmDeleteCase(state, deps) {
  const caseId = state.deleteConfirmCaseId || state.currentCaseId;
  if (!caseId) return;
  await deleteCaseById(state, caseId, { skipConfirm: true }, deps);
}

export async function deleteCase(state, deps) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  deps.openDeleteCaseModal(state.currentCaseId);
}