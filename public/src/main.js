import { expandNameTerms, maskPrivacyText } from "./privacyFilter.js";
import {
  isHackathonMode as isHackathonModeForState,
  refreshCreditsBalance as refreshCreditsBalanceForState,
  refreshHackathon as refreshHackathonCore
} from "./refresh.js";
import {
  refreshCases as refreshCasesFlow,
  loadCase as loadCaseFlow,
  createCase as createCaseFlow,
  syncWalletCases as syncWalletCasesFlow,
  confirmDeleteCase as confirmDeleteCaseFlow
} from "./casesFlow.js";
import {
  shortenAddress,
  connectWallet as connectWalletFlow,
  disconnectWallet as disconnectWalletFlow,
  createSmartAccount as createSmartAccountFlow,
  enableSmartAccount as enableSmartAccountFlow,
  upgradeMetaMaskLive as upgradeMetaMaskLiveFlow
} from "./walletFlow.js";
import {
  caseIsActivated as caseIsActivatedForState,
  refreshIntegrationsStatus as refreshIntegrationsStatusFlow,
  preparePayment as preparePaymentFlow,
  ensureCasePayment as ensureCasePaymentFlow
} from "./paymentsFlow.js";
import {
  runVenice as runVeniceFlow,
  delegateAgents as delegateAgentsFlow,
  relayPayment as relayPaymentFlow,
  askAgent as askAgentFlow,
  agentAutopilot as agentAutopilotFlow
} from "./agentFlow.js";
import { PANELS, invalidate, renderIfDirty, renderAll as renderAllPanels } from "./renderScheduler.js";
import { bindIntakeFlow, SIMPLE_PRESET_DEFAULTS, AGENT_INTAKE_TEMPLATES } from "./intakeFlow.js";
import { bindGuideFlow, GUIDE_STEPS, WORKFLOW_PHASES } from "./guideFlow.js";
import { bindDiscoveryUi } from "./discoveryUi.js";
import { bindPanelRenderers } from "./panelRenderers.js";
import { bindOnboardingFlow } from "./onboardingFlow.js";
import { bindCaseActions } from "./caseActions.js";
import { readStoredTheme } from "./theme.js";
import { apiRequest, getCaseToken, setCaseToken } from "./apiClient.js";
import { createWalletLogger } from "./walletLog.js";
import { bindIcons } from "./icons.js";
import { isAgentVoiceEnabled } from "./agentVnTts.js";
import {
  bindUiHelpers,
  chipClass,
  isUserRejectedError,
  paymentErrorMessage,
  pillClass,
  yesNo
} from "./uiHelpers.js";
import { createWrite } from "./safeWrite.js";
import { wireUi, bootstrapApp } from "./wireUi.js";

const request = apiRequest;
const tokenDeps = { getCaseToken, setCaseToken };

const state = {
  cases: [],
  currentCaseId: localStorage.getItem("oblivion.currentCaseId") || "",
  currentStatus: null,
  vaultKey: null,
  trustProof: null,
  privacy: null,
  presets: [],
  agentPlan: null,
  connectorResults: [],
  products: [],
  creditRates: null,
  creditsBalance: null,
  aiEntitlement: null,
  contactEmail: "",
  operatorEmailRelay: true,
  hackathon: null,
  hackathonStatus: null,
  integrationsStatus: null,
  pendingRelayBundle: null,
  x402Config: null,
  discoveryPlan: null,
  discoveryBusy: false,
  selectedPaymentMode: localStorage.getItem("oblivion.paymentMode") || "one-off",
  agentNext: null,
  chatMessages: [
    {
      id: 1,
      role: "agent",
      text: "Hi — I'm your cleanup agent. I find listings, draft opt-outs, and pause for your approval before anything is sent.",
      animate: false
    },
    {
      id: 2,
      role: "agent",
      text: "Quick start: enter your name on the left, keep People-search selected, then tap Start cleanup. I'll ask you to confirm each match — Yes or Not me.",
      animate: false
    }
  ],
  walletAddress: "",
  smartAccountAddress: "",
  ethereumProvider: null,
  walletConfig: null,
  walletMode: "",
  smartAccountTxHash: "",
  walletCallsId: "",
  walletConnectNote: "",
  walletConnectError: "",
  walletPickAccount: false,
  appOpen: false,
  tab: "overview",
  actionType: "broker-opt-out",
  selectedPresetId: "people-search-cleanup",
  recommendedPresetId: "people-search-cleanup",
  intakeText: "",
  dockOpen: false,
  dockPinned: true,
  sidebarOpen: localStorage.getItem("oblivion.sidebarOpen") !== "0",
  showRouteTab: false,
  showAdvancedUI: false,
  autopilotBusy: false,
  casesPanelOpen: false,
  walletModalOpen: false,
  deleteConfirmCaseId: "",
  preSearchReady: false,
  onboardingPreviewReady: false,
  onboardingPreviewBusy: false,
  onboardingPreviewUrls: [],
  privacyFilterMode: localStorage.getItem("oblivion.privacyFilter") === "1",
  themeId: readStoredTheme(),
  agentVoiceEnabled: isAgentVoiceEnabled(),
  sessionHandoffWarning: "",
  paymentRailsNotice: ""
};

const PRIVACY_FILTER_INPUT_IDS = [
  "simple-name",
  "simple-alias",
  "simple-region",
  "simple-urls",
  "agent-intake",
  "intake",
  "findings-paste-input",
  "purpose",
  "destination"
];

const $ = (selector) => document.querySelector(selector);
const output = $("#output");
const chatMessageSeqRef = { value: 2 };
const chatTypewriterTimersRef = { value: [] };

function renderWalletDebugLog(entries) {
  const pre = $("#wallet-debug-log");
  if (!pre || !entries?.length) return;
  pre.textContent = entries
    .map((e) => `${e.ts} [${e.level}] ${e.message}${e.detail ? ` — ${e.detail}` : ""}`)
    .join("\n");
}

const walletLog = createWalletLogger(renderWalletDebugLog);

const modDeps = {
  state,
  $,
  request,
  tokenDeps,
  pillClass,
  chipClass,
  yesNo,
  isUserRejectedError,
  paymentErrorMessage,
  shortenAddress,
  renderWalletDebugLog,
  AGENT_INTAKE_TEMPLATES,
  SIMPLE_PRESET_DEFAULTS,
  GUIDE_STEPS,
  WORKFLOW_PHASES,
  chatMessageSeqRef,
  chatTypewriterTimersRef,
  currentCase: () => state.cases.find((item) => item.id === state.currentCaseId) || null,
  isOnboardingWithoutCase: () => state.appOpen && !modDeps.currentCase(),
  refreshIntegrationsStatus: () => refreshIntegrationsStatusFlow(state, request),
  agentAutopilot: (options) => agentAutopilotFlow(state, options, agentDepsRef.current),
  render: null,
  write: null,
  openApp: null,
  startSimpleCleanup: null,
  refreshTrust: null,
  syncCurrentCaseStatus: null,
  refreshAgentPlan: null,
  refreshHackathon: null,
  personLabelFromIntake: null,
  assertCaseActivatedClient: null,
  caseDeleteLabel: null,
  escapeHtml: null,
  displayPlainText: null,
  setInlineStatus: null,
  walletErrorMarkup: null
};

const intake = bindIntakeFlow(modDeps);
Object.assign(modDeps, intake);
modDeps.personLabelFromIntake = intake.personLabelFromIntake;

const {
  collectPrivacyTerms,
  displayPlainText,
  escapeHtml,
  setInlineStatus,
  walletErrorMarkup
} = bindUiHelpers({
  $,
  state,
  currentCase: modDeps.currentCase,
  personLabelFromIntake: intake.personLabelFromIntake,
  expandNameTerms,
  maskPrivacyText
});
Object.assign(modDeps, { escapeHtml, displayPlainText, setInlineStatus, walletErrorMarkup });

function isLiveExecutorMode() {
  return state.integrationsStatus?.executorMode === "live";
}

function executeActionLabel() {
  return isLiveExecutorMode() ? "Execute" : "Record";
}

function actionTypesNeedingEmailHandoff(actionType) {
  return actionType === "hibp-email-check" || actionType === "broker-opt-out";
}

function handoffReadinessWarning(action) {
  const warnings = [];
  if (!state.intakeText && actionTypesNeedingEmailHandoff(action?.actionType)) {
    warnings.push(
      "Email handoff needs intake text in this browser session — re-paste intake or open the case without refreshing."
    );
  }
  if (!state.vaultKey && action?.actionType === "pwned-password-range-check") {
    warnings.push("Vault key is only in memory for cases opened this session.");
  }
  return warnings.join(" ");
}

const caseActionsDeps = {
  state,
  $,
  request,
  tokenDeps,
  displayPlainText,
  isLiveExecutorMode,
  handoffReadinessWarning,
  addChat: null,
  loadCaseFlow,
  render: (...args) => modDeps.render(...args),
  write: (value) => modDeps.write(value),
  renderVaultPanel: () => modDeps.renderVaultPanel?.(),
  focusIntake: () => modDeps.focusIntake?.(),
  casesDeps: null,
  refreshHackathon: (options) => refreshHackathon(options)
};
const actions = bindCaseActions(caseActionsDeps);
Object.assign(modDeps, actions);

const onboardingFlowDeps = {
  state,
  $,
  request,
  escapeHtml,
  paymentErrorMessage,
  isUserRejectedError,
  setInlineStatus,
  SIMPLE_PRESET_DEFAULTS,
  AGENT_INTAKE_TEMPLATES,
  parseIntakeForCase: intake.parseIntakeForCase,
  urlsFromText: intake.urlsFromText,
  selectPresetId: intake.selectPresetId,
  onboardingPresetId: intake.onboardingPresetId,
  readSimpleIntakeForm: intake.readSimpleIntakeForm,
  intakeTextForPreset: intake.intakeTextForPreset,
  syncJurisdictionFromRegionLabel: intake.syncJurisdictionFromRegionLabel,
  presentPreset: intake.presentPreset,
  presetTitle: intake.presetTitle,
  currentCase: actions.currentCase,
  addChat: null,
  shortenUrl: null,
  discoverySearchReady: null,
  streamBrokerPreviewResults: null,
  previewStatsMessage: null,
  renderBrokerPreviewResults: null,
  maybeAutoDiscoverFindings: null,
  createCaseFlow,
  connectWalletFlow,
  agentAutopilotFlow,
  assertCaseActivatedClient: null,
  syncCurrentCaseStatus: actions.syncCurrentCaseStatus,
  refreshIntegrationsStatus: modDeps.refreshIntegrationsStatus,
  startPreset: null,
  render: (...args) => modDeps.render(...args),
  write: (value) => modDeps.write(value),
  updateAgentSendState: actions.updateAgentSendState,
  updateLandingSendState: actions.updateLandingSendState,
  walletDeps: null,
  casesDeps: null,
  agentDeps: null,
  refreshAgentPlan: (options) => actions.refreshAgentPlan(options),
  refreshHackathon: (options) => refreshHackathon(options)
};
const onboarding = bindOnboardingFlow(onboardingFlowDeps);
Object.assign(modDeps, onboarding);
modDeps.isOnboardingWithoutCase = onboarding.isOnboardingWithoutCase;

function caseIsActivated() {
  return caseIsActivatedForState(state);
}

function assertCaseActivatedClient(options = {}) {
  if (caseIsActivated()) return;
  if (!options.quiet) {
    modDeps.addChat("agent", "Connect your wallet and buy credits for this case before continuing.");
    modDeps.openPaymentRails();
  }
  throw {
    error: "case-activation-required",
    message: "Buy credits for this case to continue cleanup."
  };
}
modDeps.assertCaseActivatedClient = assertCaseActivatedClient;
modDeps.isLiveExecutorMode = isLiveExecutorMode;
modDeps.executeActionLabel = executeActionLabel;

const guide = bindGuideFlow(modDeps);
Object.assign(modDeps, guide);

const panels = bindPanelRenderers(modDeps);
Object.assign(modDeps, panels);
modDeps.caseDeleteLabel = actions.caseDeleteLabel;

const discovery = bindDiscoveryUi(modDeps);
Object.assign(modDeps, discovery);

Object.assign(onboardingFlowDeps, {
  addChat: panels.addChat,
  shortenUrl: discovery.shortenUrl,
  discoverySearchReady: discovery.discoverySearchReady,
  streamBrokerPreviewResults: discovery.streamBrokerPreviewResults,
  previewStatsMessage: discovery.previewStatsMessage,
  renderBrokerPreviewResults: discovery.renderBrokerPreviewResults,
  maybeAutoDiscoverFindings: discovery.maybeAutoDiscoverFindings,
  assertCaseActivatedClient,
  startPreset: onboarding.startPreset
});
caseActionsDeps.addChat = panels.addChat;

const {
  parseIntakeForCase,
  personLabelFromIntake,
  urlsFromText,
  recommendPreset,
  applyParsedIntakeToForm,
  renderIntakeInferencePreview,
  selectPresetId,
  onboardingPresetId,
  readSimpleIntakeForm,
  intakeTextForPreset,
  syncJurisdictionFromRegionLabel,
  presentPreset,
  presetTitle
} = intake;

const {
  currentGuideStep,
  guidePrimaryLabel,
  performGuidePrimaryAction,
  buildTeeVerificationBrief,
  teeQuestionIntent,
  revealRouteTab,
  runtimeLabel,
  renderUserGuide
} = guide;

const {
  panelRenderers,
  addChat,
  renderTrust,
  renderCases,
  renderWalletPanels,
  renderWalletModal,
  toggleWalletModal,
  openPaymentRails,
  openWalletHub,
  renderAppearanceSettings,
  renderOnboardingSteps,
  renderAgentChat,
  shortStepTitle,
  selectPaymentMode,
  dismissSubscriptionUpsell,
  syncPaymentPlanFromForm,
  renderPayments,
  renderSubscriptionUpsell,
  renderVaultPanel,
  hackathonPendingTracks
} = panels;

const {
  maybeAutoDiscoverFindings,
  discoverFindings,
  decideFinding,
  peopleSearchPresetActive,
  needsExposureDiscovery,
  openFindingsPastePanel,
  streamBrokerPreviewResults,
  brokerPreviewResultMarkup,
  previewStatsMessage,
  renderBrokerPreviewResults
} = discovery;

const {
  currentCase,
  syncAppRoute,
  refreshTrust,
  refreshPresets,
  refreshAgentPlan,
  syncCurrentCaseStatus,
  hasActiveCase,
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
  proposeAction,
  approve,
  executeAction,
  exportRecoveryKit,
  importRecoveryKit,
  exportCase,
  resetPreSearchUi,
  startSimpleCleanup,
  startWithAgent,
  startPreset,
  startFromLanding,
  runOnboardingPreview,
  applyAgentIntakeTemplate,
  applyAdvancedUiVisibility,
  openNewCaseFlow,
  copySkillInstallCommand,
  setupLandingSkillInstall,
  setupLandingLocationCombobox,
  setupOnboardingRegionCombobox,
  focusIntake,
  fillAgentInput
} = { ...actions, ...onboarding };

modDeps.addChat = addChat;
modDeps.renderVaultPanel = renderVaultPanel;

function updateSessionHandoffWarning() {
  if (!state.currentCaseId) {
    state.sessionHandoffWarning = "";
    return;
  }
  const parts = [];
  if (!state.vaultKey) {
    parts.push("Vault key is only in memory for cases opened this session.");
  }
  if (!state.intakeText) {
    parts.push("Intake text is not loaded — live email handoffs need intake re-entered after refresh.");
  }
  state.sessionHandoffWarning = parts.join(" ");
}

function applyPrivacyFilterToInputs() {
  PRIVACY_FILTER_INPUT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || !("value" in el)) return;
    if (state.privacyFilterMode) {
      if (el.dataset.privacyRealValue === undefined) {
        el.dataset.privacyRealValue = el.value;
      }
      el.value = maskPrivacyText(el.dataset.privacyRealValue, collectPrivacyTerms());
      el.readOnly = true;
      el.setAttribute("aria-readonly", "true");
    } else if (el.dataset.privacyRealValue !== undefined) {
      el.value = el.dataset.privacyRealValue;
      delete el.dataset.privacyRealValue;
      el.readOnly = false;
      el.removeAttribute("aria-readonly");
    }
  });
}

function afterPanelRender() {
  applyPrivacyFilterToInputs();
  updateAgentSendState();
  updateLandingSendState();
  bindIcons();
}

function renderAll() {
  renderAllPanels(panelRenderers(), afterPanelRender);
}

function render(...panelsToRefresh) {
  if (panelsToRefresh.length) {
    invalidate(...panelsToRefresh);
  } else {
    invalidate(...Object.values(PANELS));
  }
  renderIfDirty(panelRenderers());
  afterPanelRender();
}

const write = createWrite(output, (value) => {
  state.currentStatus = value.caseStatus;
  if (value.plan) state.agentPlan = value.plan;
  if (value.connectorResults) state.connectorResults = value.connectorResults;
  render(PANELS.dashboard, PANELS.agentChat, PANELS.approvals, PANELS.actions);
});

modDeps.render = render;
modDeps.write = write;
modDeps.openApp = openApp;
modDeps.startSimpleCleanup = startSimpleCleanup;
modDeps.refreshTrust = refreshTrust;
modDeps.syncCurrentCaseStatus = syncCurrentCaseStatus;
modDeps.refreshAgentPlan = refreshAgentPlan;
modDeps.refreshHackathon = refreshHackathon;
modDeps.focusIntake = focusIntake;

async function refreshCreditsBalance() {
  return refreshCreditsBalanceForState(state, request);
}

async function refreshHackathon(options = {}) {
  return refreshHackathonCore(state, request, {
    ...options,
    onWrite: options.silent ? undefined : write
  });
}

const agentDepsRef = { current: null };

const walletDeps = {
  walletLog,
  $,
  request,
  render,
  write,
  renderWalletPanels,
  toggleWalletModal,
  openWalletHub,
  addChat,
  refreshHackathon,
  refreshCreditsBalance,
  hackathonPendingTracks,
  isHackathonMode: isHackathonModeForState,
  paymentErrorMessage,
  hasActiveCase,
  syncWalletCases: (s) => syncWalletCasesFlow(s, casesDeps)
};

const paymentDeps = {
  request,
  $,
  addChat,
  write,
  refreshHackathon,
  renderPayments,
  renderSubscriptionUpsell,
  openPaymentRails,
  setInlineStatus,
  paymentErrorMessage,
  isUserRejectedError,
  walletDeps
};

const casesDeps = {
  request,
  $,
  tokenDeps,
  render,
  write,
  refreshAgentPlan,
  refreshHackathon,
  resetPreSearchUi,
  updateSessionHandoffWarning,
  connectWallet: (options) => connectWalletFlow(state, options, walletDeps),
  parseIntakeForCase,
  applyParsedIntakeToForm,
  syncPaymentPlanFromForm,
  ensureCasePayment: (options) => ensureCasePaymentFlow(state, options, paymentDeps),
  syncCurrentCaseStatus,
  recommendPreset,
  addChat,
  startPreset,
  maybeAutoDiscoverFindings,
  agentAutopilot: (options) => agentAutopilotFlow(state, options, agentDepsRef.current),
  presetTitle,
  openDeleteCaseModal,
  closeDeleteCaseModal
};

if (typeof document !== "undefined") {
  window.__oblivionLoadCase = (caseId, options = {}) => loadCaseFlow(state, caseId, options, casesDeps);
}

const agentDeps = {
  request,
  $,
  render,
  write,
  addChat,
  refreshHackathon,
  refreshAgentPlan,
  syncCurrentCaseStatus,
  connectWallet: (options) => connectWalletFlow(state, options, walletDeps),
  refreshIntegrationsStatus: modDeps.refreshIntegrationsStatus,
  assertCaseActivatedClient,
  startPreset,
  peopleSearchPresetActive,
  needsExposureDiscovery,
  maybeAutoDiscoverFindings,
  openFindingsPastePanel,
  shortStepTitle,
  teeQuestionIntent,
  buildTeeVerificationBrief,
  renderIntakeInferencePreview,
  startWithAgent,
  updateAgentSendState,
  openPaymentRails
};
agentDepsRef.current = agentDeps;

Object.assign(onboardingFlowDeps, { walletDeps, casesDeps, agentDeps });
caseActionsDeps.casesDeps = casesDeps;

wireUi({
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
  applyAgentIntakeTemplate,
  applyAdvancedUiVisibility,
  openNewCaseFlow,
  backToLanding,
  toggleSidebar,
  toggleCasesPanel,
  refreshTrust,
  startPreset,
  proposeAction,
  toggleWalletModal,
  disconnectWalletFlow,
  connectWalletFlow,
  upgradeMetaMaskLiveFlow,
  enableSmartAccountFlow,
  createSmartAccountFlow,
  renderWalletModal,
  renderWalletPanels,
  walletLog,
  walletDeps,
  runVeniceFlow,
  delegateAgentsFlow,
  relayPaymentFlow,
  askAgentFlow,
  agentDeps,
  updateAgentSendState,
  updateLandingSendState,
  exportRecoveryKit,
  exportCase,
  importRecoveryKit,
  closeDeleteCaseModal,
  confirmDeleteCaseFlow,
  casesDeps,
  approve,
  executeAction,
  decideFinding,
  discoverFindings,
  preparePaymentFlow,
  paymentDeps,
  selectPaymentMode,
  dismissSubscriptionUpsell,
  addChat,
  copySkillInstallCommand,
  openAgentDock,
  toggleDockPinned,
  syncAppRoute,
  refreshPresets,
  refreshIntegrationsStatus: modDeps.refreshIntegrationsStatus,
  refreshHackathon,
  openPaymentRails,
  setupLandingSkillInstall,
  setupLandingLocationCombobox,
  setupOnboardingRegionCombobox
});

await bootstrapApp({
  state,
  write,
  render,
  syncAppRoute,
  refreshPresets,
  refreshTrust,
  refreshIntegrationsStatus: modDeps.refreshIntegrationsStatus,
  refreshCasesFlow,
  casesDeps,
  refreshHackathon
});