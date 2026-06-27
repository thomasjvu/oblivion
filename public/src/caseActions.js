import * as Vault from "./crypto.js";
import { buildExecuteHandoff } from "./executeHandoff.js";
import { PANELS } from "./renderScheduler.js";
import { saveLocalCases as saveLocalCasesFlow } from "./casesFlow.js";
import { getCaseToken, setCaseToken } from "./apiClient.js";
import { bindIcons } from "./icons.js";

export function bindCaseActions(deps) {
  const {
    state,
    $,
    request,
    tokenDeps,
    displayPlainText,
    isLiveExecutorMode,
    handoffReadinessWarning,
    loadCaseFlow
  } = deps;

  function currentCase() {
    return state.cases.find((item) => item.id === state.currentCaseId) || null;
  }

  function syncAppRoute() {
    state.appOpen = location.hash === "#app";
  }

  async function refreshTrust() {
    const [proof, privacy] = await Promise.all([
      request("/api/trust/attestation"),
      request("/api/trust/privacy")
    ]);
    state.trustProof = proof;
    state.privacy = privacy;
    deps.render(PANELS.trust);
    return proof;
  }

  async function refreshPresets() {
    const result = await request("/api/presets");
    state.presets = result.presets || [];
    if (!state.presets.some((preset) => preset.id === state.selectedPresetId)) {
      state.selectedPresetId = state.presets[0]?.id || "people-search-cleanup";
    }
  }

  async function refreshAgentPlan(options = {}) {
    if (!state.currentCaseId) {
      state.agentPlan = null;
      state.connectorResults = [];
      return;
    }
    const result = await request(`/api/cases/${state.currentCaseId}/plan`);
    state.agentPlan = result.plan;
    state.connectorResults = result.connectorResults || [];
    if (result.presets?.length) state.presets = result.presets;
    if (!options.silent) deps.write(result);
  }

  async function syncCurrentCaseStatus() {
    if (!state.currentCaseId) return;
    const loaded = await request(`/api/cases/${state.currentCaseId}`);
    state.currentStatus = loaded.status;
    const index = state.cases.findIndex((item) => item.id === state.currentCaseId);
    const summary = { ...loaded.case, status: loaded.status };
    if (index >= 0) state.cases[index] = summary;
    else state.cases.unshift(summary);
    saveLocalCasesFlow(state, tokenDeps);
  }

  function hasActiveCase() {
    return Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function updateAgentSendState() {
    const input = $("#agent-input");
    const send = $("#agent-send");
    if (!input || !send) return;
    const hasText = Boolean(input.value.trim());
    send.disabled = !hasText;
    send.classList.toggle("send-ready", hasText);
    send.setAttribute("aria-disabled", hasText ? "false" : "true");
  }

  function landingInputValue() {
    const input = $("#landing-input");
    if (!input) return "";
    const raw = input.dataset.privacyRealValue ?? input.value;
    return String(raw).trim();
  }

  function updateLandingSendState() {
    const send = $("#landing-send");
    if (!send) return;
    const hasText = Boolean(landingInputValue());
    send.disabled = !hasText;
    send.classList.toggle("send-ready", hasText);
    send.setAttribute("aria-disabled", hasText ? "false" : "true");
  }

  function toggleCasesPanel(open) {
    if (typeof open === "boolean") state.casesPanelOpen = open;
    else state.casesPanelOpen = !state.casesPanelOpen;
    deps.render(PANELS.cases);
  }

  function openApp() {
    state.appOpen = true;
    state.dockOpen = true;
    state.dockPinned = true;
    location.hash = "app";
    if (state.currentCaseId) {
      loadCaseFlow(state, state.currentCaseId, { silent: true, openApp: false }, deps.casesDeps).catch(deps.write);
      return;
    }
    deps.render();
    deps.focusIntake();
  }

  function backToLanding() {
    state.appOpen = false;
    state.dockOpen = false;
    location.hash = "";
    deps.render();
    $("#landing-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    localStorage.setItem("oblivion.sidebarOpen", state.sidebarOpen ? "1" : "0");
    deps.render(PANELS.shell);
  }

  function openAgentDock() {
    state.dockPinned = true;
    state.dockOpen = true;
    $("#app-agent-column")?.classList.add("open");
    $("#agent-dock")?.classList.add("open");
    deps.render();
  }

  function toggleDockPinned() {
    state.dockPinned = !state.dockPinned;
    if (state.dockPinned) {
      state.dockOpen = true;
      $("#app-agent-column")?.classList.add("open");
      $("#agent-dock")?.classList.add("open");
    } else {
      $("#app-agent-column")?.classList.remove("open");
      $("#agent-dock")?.classList.remove("open");
    }
    deps.render();
  }

  function caseDeleteLabel(caseId) {
    return state.cases.find((item) => item.id === caseId)?.redactedScope?.personLabel || "this case";
  }

  function openDeleteCaseModal(caseId) {
    if (!caseId) return;
    const label = caseDeleteLabel(caseId);
    state.deleteConfirmCaseId = caseId;
    const copy = $("#delete-case-modal-copy");
    if (copy) {
      copy.textContent = `Delete ${displayPlainText(label)}? Server data will be purged and cannot be recovered.`;
    }
    const dialog = $("#delete-case-modal");
    if (dialog && !dialog.open) {
      dialog.showModal();
      bindIcons(dialog);
    }
  }

  function closeDeleteCaseModal() {
    state.deleteConfirmCaseId = "";
    $("#delete-case-modal")?.close();
  }

  async function requireTrustedRuntime() {
    if (!$("#require-trust").checked) return;
    const proof = state.trustProof || (await refreshTrust());
    if (proof.verifierResult !== "pass") {
      throw {
        error: "attestation-required",
        message: "Sensitive action blocked until Trust Center status is pass."
      };
    }
  }

  async function proposeAction() {
    if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
    await requireTrustedRuntime();
    const result = await request("/api/actions/propose", {
      method: "POST",
      body: {
        caseId: state.currentCaseId,
        actionType: state.actionType,
        destination: $("#destination").value,
        purpose: $("#purpose").value,
        identifiers: ["email"],
        dataToDisclose: ["email"],
        sourceVerified: $("#source-verified").checked
      }
    });
    state.currentStatus = result.status;
    state.tab = "approvals";
    deps.render(PANELS.tabs, PANELS.approvals, PANELS.actions);
    deps.write(result);
  }

  async function approve(approvalId) {
    const result = await request(`/api/approvals/${approvalId}/approve`, {
      method: "POST",
      body: { userConfirmation: "I approve this exact action" }
    });
    state.currentStatus = result.status;
    await refreshAgentPlan({ silent: true }).catch(() => {});
    await deps.refreshHackathon({ silent: true, scope: "agent" });
    deps.addChat(
      "agent",
      isLiveExecutorMode()
        ? "Approved. I can execute the live connector path when you confirm — still only what you approved."
        : "Approved. I can record it without external submission."
    );
    state.tab = "overview";
    deps.render();
    deps.write(result);
  }

  async function executeAction(actionId) {
    const action =
      state.currentStatus?.actionsReady?.find((item) => item.id === actionId) ||
      state.currentStatus?.submittedActions?.find((item) => item.id === actionId);
    const passwordPlaintext =
      action?.actionType === "pwned-password-range-check" ? $("#breach-password-vault")?.value || "" : "";
    const handoffWarning = handoffReadinessWarning(action);
    if (handoffWarning) {
      deps.addChat("agent", handoffWarning);
      state.sessionHandoffWarning = handoffWarning;
      deps.renderVaultPanel();
    }
    const hashPrefix =
      passwordPlaintext && action?.actionType === "pwned-password-range-check"
        ? await Vault.sha1PrefixFromPassword(passwordPlaintext)
        : undefined;
    const handoff = buildExecuteHandoff({
      action,
      status: state.currentStatus,
      intakeText: state.intakeText,
      contactEmail: state.contactEmail,
      hashPrefix
    });
    const result = await request(`/api/actions/${actionId}/execute`, {
      method: "POST",
      body: { ...handoff, walletAddress: state.walletAddress || undefined }
    });
    state.currentStatus = result.status;
    await refreshAgentPlan({ silent: true }).catch(() => {});
    await deps.refreshHackathon({ silent: true, scope: "agent" });
    const live = result.executorMode === "live";
    const mailto = result.connectorResult?.mailtoUrl;
    const handoffNote = mailto
      ? " Use Open in email app to send the approved draft."
      : result.connectorResult?.requiresUserHandoff
        ? " Open the official path to finish submission."
        : "";
    deps.addChat(
      "agent",
      live
        ? `Live connector path: ${result.connectorResult?.summary || result.action?.executionRecord || "executed."}${handoffNote}`
        : "Recorded. No third-party submission without your explicit approval path."
    );
    if (mailto) {
      state.lastMailtoUrl = mailto;
    }
    state.tab = "overview";
    deps.render();
    deps.write(result);
  }

  async function exportRecoveryKit() {
    if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
    const accessToken = getCaseToken(state.currentCaseId);
    if (!accessToken) {
      throw { error: "token-missing", message: "Case access token is not in this browser. Import a recovery kit first." };
    }
    const passphrase = $("#export-passphrase")?.value?.trim() || "";
    if (passphrase && passphrase.length < 12) {
      throw { error: "passphrase-too-short", message: "Use at least 12 characters to wrap the recovery kit." };
    }
    if (passphrase && !state.vaultKey) {
      throw {
        error: "vault-key-missing",
        message: "Vault key is not in memory. Omit the passphrase or open the case in this session."
      };
    }
    const kit = {
      format: "oblivion-recovery-kit-v1",
      exportedAt: new Date().toISOString(),
      caseId: state.currentCaseId,
      accessToken,
      wrappedVaultKey: passphrase ? await Vault.wrapVaultKey(state.vaultKey, passphrase) : undefined
    };
    const label = (currentCase()?.redactedScope?.personLabel || "case")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "case";
    downloadJson(`oblivion-recovery-${label}-${state.currentCaseId.slice(0, 8)}.json`, kit);
    const status = $("#vault-status");
    if (status) {
      status.textContent = `Recovery kit downloaded${passphrase ? " with wrapped vault key" : ""}.`;
      status.className = "vault-status muted small pass";
    }
  }

  async function importRecoveryKit(file, passphrase = "") {
    if (!file) throw { error: "file-required", message: "Choose a recovery kit JSON file." };
    const text = await file.text();
    const kit = JSON.parse(text);
    if (kit.format !== "oblivion-recovery-kit-v1" || !kit.caseId || !kit.accessToken) {
      throw { error: "recovery-kit-invalid", message: "File is not a valid Oblivion recovery kit." };
    }
    setCaseToken(kit.caseId, kit.accessToken);
    if (kit.wrappedVaultKey) {
      state.vaultKey = await Vault.unwrapVaultKey(kit.wrappedVaultKey, passphrase);
    }
    const summary = {
      id: kit.caseId,
      jurisdiction: kit.jurisdiction || "US",
      updatedAt: kit.exportedAt || new Date().toISOString()
    };
    if (!state.cases.some((item) => item.id === kit.caseId)) {
      state.cases.unshift(summary);
    }
    state.currentCaseId = kit.caseId;
    saveLocalCasesFlow(state, tokenDeps);
    await loadCaseFlow(state, kit.caseId, { silent: true, openApp: true }, deps.casesDeps).catch(() => {});
    const status = $("#vault-status");
    if (status) {
      status.textContent = `Imported recovery kit for ${caseDeleteLabel(kit.caseId)}.`;
      status.className = "vault-status muted small pass";
    }
  }

  async function exportCase() {
    if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
    const passphrase = $("#export-passphrase")?.value?.trim() || "";
    if (passphrase && passphrase.length < 12) {
      throw { error: "passphrase-too-short", message: "Use at least 12 characters to wrap the vault key." };
    }
    if (passphrase && !state.vaultKey) {
      throw {
        error: "vault-key-missing",
        message: "Vault key is not in memory. Omit the passphrase or create the case in this session."
      };
    }
    const exported = await request("/api/export", {
      method: "POST",
      body: { caseId: state.currentCaseId }
    });
    const bundle = {
      format: "oblivion-encrypted-case-v1",
      exportedAt: new Date().toISOString(),
      wrappedVaultKey: passphrase ? await Vault.wrapVaultKey(state.vaultKey, passphrase) : undefined,
      payload: exported
    };
    const label = (currentCase()?.redactedScope?.personLabel || "case")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "case";
    downloadJson(`oblivion-${label}-${state.currentCaseId.slice(0, 8)}.json`, bundle);
    const status = $("#vault-status");
    if (status) {
      status.textContent = `Downloaded backup${passphrase ? " with wrapped vault key" : ""}.`;
      status.className = "vault-status muted small pass";
    }
  }

  return {
    currentCase,
    syncAppRoute,
    refreshTrust,
    refreshPresets,
    refreshAgentPlan,
    syncCurrentCaseStatus,
    hasActiveCase,
    downloadJson,
    updateAgentSendState,
    updateLandingSendState,
    toggleCasesPanel,
    openApp,
    backToLanding,
    toggleSidebar,
    openAgentDock,
    toggleDockPinned,
    caseDeleteLabel,
    openDeleteCaseModal,
    closeDeleteCaseModal,
    requireTrustedRuntime,
    proposeAction,
    approve,
    executeAction,
    exportRecoveryKit,
    importRecoveryKit,
    exportCase
  };
}