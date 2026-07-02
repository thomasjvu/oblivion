import { PANELS } from "./renderScheduler.js";
import { setTheme } from "./theme.js";
import { loadApiConfig } from "./apiClient.js";
import { setAgentVoiceEnabled } from "./agentVnTts.js";
import {
  refreshCases as refreshCasesFlow,
  loadCase as loadCaseFlow,
  deleteCaseById as deleteCaseByIdFlow,
  confirmDeleteCase as confirmDeleteCaseFlow
} from "./casesFlow.js";
import {
  connectWallet as connectWalletFlow,
  disconnectWallet as disconnectWalletFlow,
  refreshWalletConfig as refreshWalletConfigFlow,
  createSmartAccount as createSmartAccountFlow,
  enableSmartAccount as enableSmartAccountFlow,
  upgradeMetaMaskLive as upgradeMetaMaskLiveFlow
} from "./walletFlow.js";
import { preparePayment as preparePaymentFlow } from "./paymentsFlow.js";
import {
  runVenice as runVeniceFlow,
  delegateAgents as delegateAgentsFlow,
  relayPayment as relayPaymentFlow,
  askAgent as askAgentFlow,
  agentAutopilot as agentAutopilotFlow
} from "./agentFlow.js";
import { applyTheme } from "./theme.js";

export function wireUi(deps) {
  const {
    state,
    $,
    write,
    render,
    revealRouteTab,
    performGuidePrimaryAction,
    startFromLanding,
    startSimpleCleanup,
    runOnboardingPreview,
    selectPresetId,
    applyAdvancedUiVisibility,
    openNewCaseFlow,
    backToLanding,
    toggleSidebar,
    toggleCasesPanel,
    refreshTrust,
    startPreset,
    proposeAction,
    toggleWalletModal,
    disconnectWalletFlow: disconnectWallet,
    connectWalletFlow: connectWallet,
    upgradeMetaMaskLiveFlow: upgradeMetaMaskLive,
    enableSmartAccountFlow: enableSmartAccount,
    createSmartAccountFlow: createSmartAccount,
    renderWalletModal,
    renderWalletPanels,
    walletLog,
    walletDeps,
    runVeniceFlow: runVenice,
    delegateAgentsFlow: delegateAgents,
    relayPaymentFlow: relayPayment,
    askAgentFlow: askAgent,
    agentDeps,
    updateAgentSendState,
    updateLandingSendState,
    exportRecoveryKit,
    exportCase,
    importRecoveryKit,
    closeDeleteCaseModal,
    confirmDeleteCaseFlow: confirmDeleteCase,
    casesDeps,
    approve,
    executeAction,
    decideFinding,
    discoverFindings,
    preparePaymentFlow: preparePayment,
    paymentDeps,
    selectPaymentMode,
    dismissSubscriptionUpsell,
    addChat,
    copySkillInstallCommand,
    openAgentDock,
    toggleDockPinned,
    syncAppRoute,
    refreshPresets,
    refreshIntegrationsStatus,
    refreshCaseContext
  } = deps;

  function setupDelegates() {
    const presetGrid = $("#preset-grid");
    if (presetGrid) {
      presetGrid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-preset-id]");
        if (btn && !btn.disabled) {
          state.selectedPresetId = btn.dataset.presetId;
          if (state.selectedPresetId !== state.recommendedPresetId) state.showRouteTab = true;
          render(PANELS.presets, PANELS.tabs);
        }
      });
      presetGrid.setAttribute("data-testid", "preset-grid");
    }

    const actionCards = $("#agent-action-cards");
    if (actionCards) {
      actionCards.addEventListener("click", (e) => {
        const approveBtn = e.target.closest("[data-chat-approve-id]");
        if (approveBtn) {
          approve(approveBtn.dataset.chatApproveId).catch(write);
          return;
        }
        const execBtn = e.target.closest("[data-chat-execute-id]");
        if (execBtn) {
          executeAction(execBtn.dataset.chatExecuteId).catch(write);
        }
      });
    }

    const approvalTable = $("#approval-table");
    if (approvalTable) {
      approvalTable.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-approve-id]");
        if (btn) approve(btn.dataset.approveId);
      });
      approvalTable.setAttribute("data-testid", "approval-table");
    }

    const actionTable = $("#action-table");
    if (actionTable) {
      actionTable.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-execute-id]");
        if (btn) executeAction(btn.dataset.executeId);
      });
    }

    const paymentRailsGrid = $("#payment-rails-grid");
    if (paymentRailsGrid) {
      paymentRailsGrid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-pay-product]");
        if (btn) preparePayment(state, btn.dataset.payMode, {}, paymentDeps).catch(write);
      });
    }

    const caseList = $("#case-list");
    if (caseList) {
      caseList.addEventListener("click", (e) => {
        const deleteBtn = e.target.closest("[data-delete-case]");
        if (deleteBtn) {
          e.preventDefault();
          deleteCaseByIdFlow(state, deleteBtn.dataset.deleteCase, {}, casesDeps).catch(write);
          return;
        }
        const btn = e.target.closest("[data-case-id]");
        if (btn) {
          state.casesPanelOpen = false;
          loadCaseFlow(state, btn.dataset.caseId, {}, casesDeps);
        }
      });
    }

    const findingsList = $("#findings-list");
    if (findingsList) {
      findingsList.addEventListener("click", (e) => {
        const confirmBtn = e.target.closest("[data-finding-confirm]");
        if (confirmBtn) {
          decideFinding(confirmBtn.dataset.findingConfirm, "confirm").catch(write);
          return;
        }
        const rejectBtn = e.target.closest("[data-finding-reject]");
        if (rejectBtn) decideFinding(rejectBtn.dataset.findingReject, "reject").catch(write);
      });
    }

    document.addEventListener("click", (e) => {
      if (e.target.closest("#findings-discover")) {
        e.preventDefault();
        discoverFindings().catch(write);
      }
    });

    document.addEventListener("change", (e) => {
      const planInput = e.target.closest('input[name="payment-plan"]');
      if (planInput) selectPaymentMode(planInput.value);
    });

    document.addEventListener("click", (e) => {
      const planCard = e.target.closest(".payment-plan-card");
      if (planCard?.dataset.paymentPlan) {
        selectPaymentMode(planCard.dataset.paymentPlan);
        return;
      }
      if (e.target.closest("#upsell-subscribe")) {
        e.preventDefault();
        preparePayment(state, "subscription", {}, paymentDeps)
          .then(() => addChat("agent", "Weekly monitor prepared. Check Settings → Payment rails for status."))
          .catch(write);
        return;
      }
      if (e.target.closest("#upsell-dismiss")) {
        e.preventDefault();
        dismissSubscriptionUpsell();
      }
    });

    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy-target]");
      if (!copyBtn) return;
      e.preventDefault();
      copySkillInstallCommand(copyBtn.dataset.copyTarget, copyBtn).catch(write);
    });
  }

  $("#start-cleanup")?.addEventListener("click", () => startSimpleCleanup().catch(write));
  $("#onboarding-check-listings")?.addEventListener("click", () => runOnboardingPreview().catch(write));
  $("#simple-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!state.onboardingPreviewReady && !state.currentCaseId) {
        runOnboardingPreview().catch(write);
      } else {
        startSimpleCleanup().catch(write);
      }
    }
  });
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      selectPresetId(chip.dataset.presetId || "people-search-cleanup");
      render(PANELS.presets);
    });
  });

  $("#show-advanced-ui")?.addEventListener("change", (event) => {
    state.showAdvancedUI = event.target.checked;
    applyAdvancedUiVisibility();
    render(PANELS.shell, PANELS.dashboard, PANELS.findings);
  });
  $("#agent-intake")?.addEventListener("input", () => render(PANELS.intakeInferencePreview));
  $("#agent-intake")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      startSimpleCleanup().catch(write);
    }
  });
  $("#agent-do-next")?.addEventListener("click", () => performGuidePrimaryAction().catch(write));
  $("#landing-send")?.addEventListener("click", () => startFromLanding().catch(write));
  $("#landing-input")?.addEventListener("input", updateLandingSendState);
  $("#landing-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      startFromLanding().catch(write);
    }
  });
  $("#toolbar-home")?.addEventListener("click", backToLanding);
  $("#sidebar-home")?.addEventListener("click", backToLanding);
  $("#sidebar-new-case")?.addEventListener("click", () => openNewCaseFlow());
  $("#sidebar-collapse")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSidebar();
  });
  window.addEventListener("hashchange", () => {
    syncAppRoute();
    if (state.appOpen && state.currentCaseId && !state.currentStatus) {
      loadCaseFlow(state, state.currentCaseId, { silent: true, openApp: false }, casesDeps).catch(() => render());
    } else {
      render();
    }
  });
  $("#refresh-dashboard")?.addEventListener("click", () => refreshTrust().then(() => refreshCasesFlow(state, casesDeps)).catch(write));
  $("#change-route")?.addEventListener("click", () => revealRouteTab());
  $("#continue-flow")?.addEventListener("click", () => revealRouteTab());
  $("#local-safe-mode")?.addEventListener("click", () => {
    $("#require-trust").checked = false;
    revealRouteTab();
  });
  $("#new-case")?.addEventListener("click", () => openNewCaseFlow());
  $("#case-manager-new")?.addEventListener("click", () => openNewCaseFlow());
  $("#toolbar-cases-toggle")?.addEventListener("click", () => toggleCasesPanel());
  $("#case-manager-close")?.addEventListener("click", () => toggleCasesPanel(false));
  $("#start-preset")?.addEventListener("click", () => startPreset().catch(write));
  $("#propose-action")?.addEventListener("click", () => proposeAction().catch(write));
  $("#wallet-modal-close")?.addEventListener("click", () => toggleWalletModal(false));
  $("#wallet-modal-disconnect")?.addEventListener("click", () => disconnectWallet(state, walletDeps).catch(write));
  $("#wallet-modal-settings")?.addEventListener("click", () => {
    toggleWalletModal(false);
    deps.openPaymentRails();
  });
  $("#wallet-modal-connect")?.addEventListener("click", () => {
    connectWallet(state, { openHub: true }, walletDeps).catch(write);
  });
  $("#wallet-modal-live-upgrade")?.addEventListener("click", () => upgradeMetaMaskLive(state, walletDeps).catch(write));
  $("#wallet-modal-smart-account")?.addEventListener("click", () => {
    enableSmartAccount(state, { quiet: false, openHub: false }, walletDeps)
      .then(() => renderWalletModal())
      .catch(write);
  });
  $("#wallet-modal")?.addEventListener("close", () => {
    state.walletModalOpen = false;
  });
  document.addEventListener("click", (event) => {
    const modalWalletBtn = event.target.closest("[data-wallet-modal]");
    if (modalWalletBtn) {
      event.preventDefault();
      event.stopPropagation();
      toggleWalletModal(true);
      return;
    }
    const walletBtn = event.target.closest("[data-connect-wallet]");
    if (walletBtn) {
      event.preventDefault();
      event.stopPropagation();
      walletLog.info("connect button clicked", { id: walletBtn.id || "delegated" });
      connectWallet(state, { openHub: walletBtn.id === "wallet-modal-connect" }, walletDeps).catch(write);
    }
  });
  $("#create-smart-account")?.addEventListener("click", () => createSmartAccount(state, {}, walletDeps).catch(write));
  document.querySelector(".theme-toggle")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".theme-toggle-btn[data-theme-choice]");
    if (!btn) return;
    const next = btn.dataset.themeChoice;
    if (!next || next === state.themeId) return;
    state.themeId = setTheme(next);
    render(PANELS.appearanceSettings);
  });
  $("#privacy-filter-toggle")?.addEventListener("change", (event) => {
    state.privacyFilterMode = Boolean(event.target.checked);
    localStorage.setItem("oblivion.privacyFilter", state.privacyFilterMode ? "1" : "0");
    render();
  });
  $("#agent-voice-toggle")?.addEventListener("change", (event) => {
    state.agentVoiceEnabled = Boolean(event.target.checked);
    setAgentVoiceEnabled(state.agentVoiceEnabled);
  });
  $("#classify-case")?.addEventListener("click", () => runVenice(state, "classify-case", agentDeps).catch(write));
  $("#draft-request")?.addEventListener("click", () => runVenice(state, "draft-request", agentDeps).catch(write));
  $("#review-approval")?.addEventListener("click", () => runVenice(state, "review-approval", agentDeps).catch(write));
  $("#delegate-agents")?.addEventListener("click", () => delegateAgents(state, agentDeps).catch(write));
  $("#relay-demo")?.addEventListener("click", () => relayPayment(state, agentDeps).catch(write));
  $("#agent-send")?.addEventListener("click", () => askAgent(state, agentDeps).catch(write));
  $("#agent-input")?.addEventListener("input", updateAgentSendState);
  $("#agent-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") askAgent(state, agentDeps).catch(write);
  });
  $("#agent-start-recommended")?.addEventListener("click", () => startPreset().catch(write));
  $("#agent-run-next")?.addEventListener("click", () => agentAutopilotFlow(state, {}, agentDeps).catch(write));
  $("#agent-review-approval")?.addEventListener("click", () => {
    state.tab = "approvals";
    state.dockOpen = false;
    render(PANELS.agentChat);
  });
  $("#agent-explain-disclosure")?.addEventListener("click", () => {
    const approval = state.currentStatus?.approvalsNeeded?.[0];
    addChat(
      "agent",
      approval
        ? `This would disclose ${approval.dataToDisclose.join(", ")} to ${approval.destination}. I will not submit it without approval.`
        : "No disclosure is pending. I will stop before any external identifier is sent."
    );
    render();
  });
  $("#agent-dock-collapse")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleDockPinned();
  });
  $("#agent-dock")?.querySelector(".agent-dock-head")?.addEventListener("click", (event) => {
    if (state.dockPinned) return;
    if (event.target.closest("button")) return;
    openAgentDock();
  });
  $("#export-recovery-kit")?.addEventListener("click", () => exportRecoveryKit().catch(write));
  $("#export")?.addEventListener("click", () => exportCase().catch(write));
  $("#import-recovery-kit")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    const passphrase = $("#import-passphrase")?.value?.trim() || "";
    if (!file) return;
    importRecoveryKit(file, passphrase)
      .catch(write)
      .finally(() => {
        event.target.value = "";
      });
  });
  $("#delete-case-modal-close")?.addEventListener("click", closeDeleteCaseModal);
  $("#delete-case-modal-cancel")?.addEventListener("click", closeDeleteCaseModal);
  $("#delete-case-modal-confirm")?.addEventListener("click", () => confirmDeleteCase(state, casesDeps).catch(write));
  $("#delete-case-modal")?.addEventListener("close", () => {
    state.deleteConfirmCaseId = "";
  });
  $("#delete-case-modal")?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeleteCaseModal();
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
      state.tab = button.dataset.tab;
      render();
    });
  });
  document.querySelectorAll("[data-action-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      state.actionType = button.dataset.actionChoice;
      document.querySelectorAll("[data-action-choice]").forEach((choice) => choice.classList.remove("active"));
      button.classList.add("active");
    });
  });

  setupDelegates();
  deps.setupLandingSkillInstall();
  deps.setupLandingLocationCombobox();
  deps.setupOnboardingRegionCombobox();
}

export async function bootstrapApp(deps) {
  const { state, write, render, syncAppRoute, refreshPresets, refreshTrust, refreshIntegrationsStatus, refreshCasesFlow: refreshCases, casesDeps, refreshCaseContext } = deps;

  syncAppRoute();
  await loadApiConfig().catch(() => null);
  await refreshPresets().catch(write);
  await refreshTrust().catch(write);
  await refreshWalletConfigFlow().catch(write);
  await refreshIntegrationsStatus().catch(write);
  await refreshCases(state, casesDeps).catch(write);
  await refreshCaseContext({ silent: true }).catch(write);
  applyTheme(state.themeId);
  render();
}