import * as Vault from './crypto.js';
import { buildExecuteHandoff } from './executeHandoff.js';
import { expandNameTerms, maskPrivacyText } from './privacyFilter.js';
import { tryLiveSmartAccountUpgrade } from './metamaskSmartAccount.js';
import { agentEndpointForMode, isLiveX402Ready, settleAgentPayment } from './x402Pay.js';
import { apiRequest, getCaseToken, loadApiConfig, removeCaseToken, setCaseToken } from './apiClient.js';
import { redactedScopeFromIntake } from './intakeScope.js';
import { pollRelayTask, submitRelayBundle } from './oneShotRelayer.js';
import { createWalletLogger, DEFAULT_WALLET_CONFIG } from './walletLog.js';
import { bindIcons, iconEl, setButtonLabel, setIcon } from './icons.js';
import { isAgentVoiceEnabled, playCharBeep, setAgentVoiceEnabled, stopAgentVoice } from './agentVnTts.js';

function isUserRejectedError(value) {
  if (!value) return false;
  if (value.reason === "user-rejected") return true;
  const code = value.code ?? value.detail?.code;
  if (code === 4001) return true;
  const message = String(value.message || value.shortMessage || value || "");
  return /user rejected the request/i.test(message);
}

function paymentErrorMessage(error) {
  if (isUserRejectedError(error)) {
    const raw = String(error?.message || error?.shortMessage || "");
    if (/smart account|upgrade/i.test(raw) || error?.reason === "user-rejected") {
      return "Smart Account upgrade cancelled in MetaMask.";
    }
    return "Payment cancelled in MetaMask.";
  }
  return error?.message || error?.shortMessage || String(error?.error || "Something went wrong.");
}

function setInlineStatus(el, message, options = {}) {
  if (!el) return;
  const text = message ? (typeof message === "string" ? message : paymentErrorMessage(message)) : "";
  const warning =
    options.variant === "warning" || (options.variant !== "success" && options.variant !== "info" && isUserRejectedError(message || text));
  const classes = [
    options.baseClass || "muted small",
    options.extraClass,
    text && warning ? "status-message warning" : "",
    text && options.variant === "fail" && !warning ? "status-message fail" : ""
  ].filter(Boolean);
  el.className = classes.join(" ");
  el.replaceChildren();
  if (!text) return;
  if (warning) el.appendChild(iconEl("alert", { className: "status-message-icon" }));
  const span = document.createElement("span");
  span.className = "status-message-text";
  span.textContent = text;
  el.appendChild(span);
  bindIcons(el);
}

function walletErrorMarkup(message) {
  if (!message) return "";
  const text = paymentErrorMessage({ message });
  const warning = isUserRejectedError(message);
  const icon = warning
    ? '<iconify-icon class="status-message-icon" icon="pixelarticons:alert" aria-hidden="true"></iconify-icon>'
    : "";
  const klass = warning ? "wallet-connect-feedback warning" : "wallet-connect-feedback fail";
  return `<p class="${klass}">${icon}<span class="status-message-text">${escapeHtml(text)}</span></p>`;
}

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
  privacyFilterMode: localStorage.getItem("oblivion.privacyFilter") === "1",
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
  "landing-input",
  "landing-location",
  "findings-paste-input",
  "purpose",
  "destination"
];

const $ = (selector) => document.querySelector(selector);
const output = $("#output");
let chatMessageSeq = 2;
let chatTypewriterTimers = [];

function renderWalletDebugLog(entries) {
  const pre = $("#wallet-debug-log");
  if (!pre || !entries?.length) return;
  pre.textContent = entries
    .map((e) => `${e.ts} [${e.level}] ${e.message}${e.detail ? ` — ${e.detail}` : ""}`)
    .join("\n");
}

const walletLog = createWalletLogger(renderWalletDebugLog);

const GUIDE_STEPS = [
  { num: 1, title: "Start", hint: "Enter your name and tap Start cleanup.", icon: "play" },
  { num: 2, title: "Review", hint: "Confirm which listings are yours.", icon: "search" },
  { num: 3, title: "Approve", hint: "Approve before anything is sent.", icon: "check" }
];

const WORKFLOW_PHASES = [
  { id: "collect-minimum-identifiers", label: "Vault" },
  { id: "verify-trust", label: "Trust" },
  { id: "discover-candidates", label: "Find" },
  { id: "confirm-matches", label: "Confirm" },
  { id: "verify-removal-path", label: "Paths" },
  { id: "draft-actions", label: "Draft" },
  { id: "request-approval", label: "Approve" },
  { id: "execute-approved-action", label: "Submit" },
  { id: "complete", label: "Done" }
];

const SIMPLE_PRESET_DEFAULTS = {
  "people-search-cleanup": { jurisdiction: "US", riskLevel: "standard" },
  "search-result-suppression": { jurisdiction: "US", riskLevel: "standard" },
  "california-drop": { jurisdiction: "US", riskLevel: "standard" },
  "gdpr-erasure": { jurisdiction: "EU", riskLevel: "standard" },
  "breach-exposure": { jurisdiction: "US", riskLevel: "standard" },
  "high-risk-safety": { jurisdiction: "US", riskLevel: "high-risk-safety" },
  "content-takedown": { jurisdiction: "US", riskLevel: "standard" }
};

const AGENT_INTAKE_TEMPLATES = {
  "people-search-cleanup": {
    name: "John Smith",
    alias: "J. Smith",
    region: "New York",
    urls: "",
    chatLine: "Data-broker and people-search cleanup for John Smith in New York (also known as J. Smith)."
  },
  "search-result-suppression": {
    name: "John Smith",
    alias: "",
    region: "New York",
    urls: "https://example.com/old-profile",
    chatLine: "Remove Google search results and source pages for John Smith in New York."
  },
  "gdpr-erasure": {
    name: "John Smith",
    alias: "",
    region: "Ireland",
    urls: "",
    chatLine: "GDPR erasure request for personal data about John Smith in Ireland."
  },
  "high-risk-safety": {
    name: "John Smith",
    alias: "J. Smith",
    region: "New York",
    urls: "",
    chatLine: "Urgent safety cleanup — remove address and profile exposure for John Smith in New York."
  },
  "content-takedown": {
    name: "Rights Holder",
    alias: "",
    region: "",
    urls: "https://example.com/unauthorized-copy",
    chatLine: "Takedown unauthorized copies of my content at the pasted URLs."
  }
};

function currentGuideStep() {
  if (!state.appOpen) return 1;
  if (!state.currentCaseId || !currentCase()) return 1;
  const pending = state.currentStatus?.pendingFindings?.length || 0;
  if (pending > 0 || state.agentPlan?.currentStep === "confirm-matches") return 2;
  const approvals = state.currentStatus?.approvalsNeeded?.length || 0;
  if (approvals > 0) return 3;
  if (state.agentPlan?.currentStep === "complete") return 3;
  return 2;
}

function guidePrimaryLabel(step) {
  if (!state.appOpen || step === 1) return "Start cleanup";
  if (step === 2) return state.currentStatus?.pendingFindings?.length ? "Continue" : "What's next?";
  if (step === 3) return "Review approval";
  return "Continue";
}

function setSkillInstallTab(tabId) {
  document.querySelectorAll("[data-skill-install-tab]").forEach((tab) => {
    const active = tab.dataset.skillInstallTab === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-skill-install-panel]").forEach((panel) => {
    const active = panel.dataset.skillInstallPanel === tabId;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

const LANDING_LOCATION_OPTIONS = [
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "New York, NY",
  "Los Angeles, CA",
  "Chicago, IL",
  "Houston, TX",
  "Phoenix, AZ",
  "Philadelphia, PA",
  "San Antonio, TX",
  "San Diego, CA",
  "Dallas, TX",
  "San Jose, CA",
  "Austin, TX",
  "Jacksonville, FL",
  "San Francisco, CA",
  "Seattle, WA",
  "Denver, CO",
  "Boston, MA",
  "Miami, FL",
  "Atlanta, GA",
  "London, UK",
  "Toronto, ON",
  "Vancouver, BC",
  "Sydney, Australia",
  "Melbourne, Australia"
];

const previewDelay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function setupLocationCombobox({ input, menu, toggle, field, options = LANDING_LOCATION_OPTIONS, onEnter }) {
  if (!input || !menu) return;

  const renderOptions = (filter = "") => {
    const needle = filter.trim().toLowerCase();
    const items = options.filter((item) => !needle || item.toLowerCase().includes(needle));
    menu.innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<li role="option" tabindex="-1" data-value="${escapeHtml(item)}">${escapeHtml(item)}</li>`
          )
          .join("")
      : `<li class="location-combobox-empty" role="presentation">No matches</li>`;
  };

  const setExpanded = (open) => {
    input.setAttribute("aria-expanded", open ? "true" : "false");
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
    field?.classList.toggle("open", open);
  };

  const openMenu = () => {
    renderOptions(input.value);
    menu.hidden = false;
    setExpanded(true);
  };

  const closeMenu = () => {
    menu.hidden = true;
    setExpanded(false);
  };

  renderOptions();

  toggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.hidden) {
      openMenu();
      input.focus();
    } else {
      closeMenu();
    }
  });

  input.addEventListener("focus", () => openMenu());
  input.addEventListener("input", () => {
    renderOptions(input.value);
    openMenu();
  });

  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    input.value = option.dataset.value || "";
    closeMenu();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const matches = [...menu.querySelectorAll("[data-value]")];
      if (!menu.hidden && matches.length === 1) {
        event.preventDefault();
        input.value = matches[0].dataset.value || input.value;
        closeMenu();
        return;
      }
      closeMenu();
      if (onEnter) {
        event.preventDefault();
        onEnter();
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!field?.contains(event.target)) closeMenu();
  });
}

function setupLandingLocationCombobox() {
  setupLocationCombobox({
    input: $("#landing-location"),
    menu: $("#landing-location-menu"),
    toggle: $("#landing-location-toggle"),
    field: $("#landing-location-field"),
    onEnter: () => startFromLanding().catch(write)
  });
}

function setupOnboardingRegionCombobox() {
  setupLocationCombobox({
    input: $("#simple-region"),
    menu: $("#onboarding-region-menu"),
    toggle: $("#onboarding-region-toggle"),
    field: $("#onboarding-region-field"),
    onEnter: () => runOnboardingPreview().catch(write)
  });
}

function isOnboardingWithoutCase() {
  return state.appOpen && !currentCase();
}

function filterDefaultWelcomeChat() {
  state.chatMessages = state.chatMessages.filter(
    (msg) => !(msg.role === "agent" && (msg.id === 1 || msg.id === 2))
  );
}

function onboardingChatTranscript() {
  const transcript = [...state.chatMessages];
  if (isOnboardingWithoutCase()) {
    return transcript.filter((msg) => !(msg.role === "agent" && (msg.id === 1 || msg.id === 2)));
  }
  return transcript;
}

function skillInstallAgentPrompt() {
  return "Install the Oblivion clean-online-identity skill: npx skills add thomasjvu/oblivion --skill clean-online-identity";
}

function setupLandingSkillInstall() {
  const origin = window.location.origin;
  const curl = $("#skill-install-curl");
  if (curl) {
    const code = curl.querySelector("code");
    if (code) code.textContent = `curl -fsSL ${origin}/skill.sh | bash`;
  }
  const prompt = $("#skill-install-prompt");
  if (prompt) {
    const code = prompt.querySelector("code");
    if (code) code.textContent = skillInstallAgentPrompt();
  }
  document.querySelectorAll("[data-skill-install-tab]").forEach((tab) => {
    tab.addEventListener("click", () => setSkillInstallTab(tab.dataset.skillInstallTab));
  });
}

async function copySkillInstallCommand(targetId, button) {
  const node = document.getElementById(targetId);
  const text = node?.querySelector("code")?.textContent?.trim() || node?.textContent?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prior = button.getAttribute("aria-label") || "Copy install command";
      button.setAttribute("aria-label", "Copied");
      window.setTimeout(() => button.setAttribute("aria-label", prior), 1400);
    }
  } catch {
    write({ error: "copy-failed", message: "Could not copy install command." });
  }
}

function fillAgentInput(text) {
  const input = $("#agent-input");
  if (!input) return;
  input.value = text;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  updateAgentSendState();
}

function applyAdvancedUiVisibility() {
  document.querySelectorAll(".advanced-only").forEach((node) => {
    node.hidden = !state.showAdvancedUI;
    node.setAttribute("aria-hidden", state.showAdvancedUI ? "false" : "true");
  });
  const glance = $("#case-glance");
  if (glance) glance.hidden = !state.showAdvancedUI;
  const subtitle = $("#case-subtitle");
  if (subtitle) subtitle.hidden = !state.showAdvancedUI;
  const walletStrip = $("#wallet-command-strip");
  if (walletStrip) walletStrip.hidden = !state.appOpen;
  const advancedToggle = $("#show-advanced-ui");
  if (advancedToggle) advancedToggle.checked = state.showAdvancedUI;
}

function onboardingPresetId() {
  return "people-search-cleanup";
}

function syncJurisdictionFromRegionLabel(region) {
  if (!region?.trim()) return;
  const parsed = parseIntakeForCase(`remove listings in ${region.trim()}`);
  const jurisdiction = $("#jurisdiction");
  const risk = $("#risk-level");
  if (jurisdiction) jurisdiction.value = parsed.jurisdiction;
  if (risk && parsed.riskLevel) risk.value = parsed.riskLevel;
}

function readSimpleIntakeForm() {
  const name = $("#simple-name")?.value?.trim();
  if (!name) throw { error: "name-required", message: "Enter your name to continue." };
  const alias = $("#simple-alias")?.value?.trim();
  const region = $("#simple-region")?.value?.trim();
  const presetId = isOnboardingWithoutCase()
    ? onboardingPresetId()
    : state.selectedPresetId || onboardingPresetId();
  const defaults = SIMPLE_PRESET_DEFAULTS[presetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const pastedUrls = ($("#simple-urls")?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const intakeText = intakeTextForPreset(presetId, { name, region, alias });
  return {
    intakeText,
    personLabel: name,
    aliases: alias ? [alias] : [],
    region,
    pastedUrls,
    presetId,
    jurisdiction: $("#jurisdiction")?.value || defaults.jurisdiction,
    authorityBasis: $("#authority")?.value || "self",
    riskLevel: $("#risk-level")?.value || defaults.riskLevel
  };
}

function intakeTextForPreset(presetId, { name, region, alias }) {
  const regionPart = region ? ` in ${region}` : "";
  const aliasPart = alias ? ` (also known as ${alias})` : "";
  switch (presetId) {
    case "search-result-suppression":
      return `Suppress Google search results and remove source pages for ${name}${regionPart}${aliasPart}.`;
    case "gdpr-erasure":
      return `Request GDPR/UK erasure for personal data about ${name}${regionPart}${aliasPart}.`;
    case "high-risk-safety":
      return `Urgent safety cleanup: remove address and profile exposure for ${name}${regionPart}${aliasPart}.`;
    case "breach-exposure":
      return `Check breach exposure and plan mitigation for ${name}${regionPart}${aliasPart}.`;
    case "california-drop":
      return `California DROP deletion request for ${name}${regionPart}${aliasPart}.`;
    case "content-takedown":
      return `Takedown unauthorized copies of my content at the URLs listed in this case.`;
    default:
      return `Remove ${name} from data-broker and people-search listings${regionPart}${aliasPart}.`;
  }
}

function selectPresetId(presetId) {
  state.selectedPresetId = presetId || "people-search-cleanup";
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.presetId === state.selectedPresetId);
  });
  document.querySelectorAll("[data-agent-preset]").forEach((starter) => {
    starter.classList.toggle("active", starter.dataset.agentPreset === state.selectedPresetId);
  });
  const defaults = SIMPLE_PRESET_DEFAULTS[state.selectedPresetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const jurisdiction = $("#jurisdiction");
  const risk = $("#risk-level");
  if (jurisdiction) jurisdiction.value = defaults.jurisdiction;
  if (risk) risk.value = defaults.riskLevel;
}

async function startFromLanding() {
  const text = $("#landing-input")?.value?.trim();
  const region = $("#landing-location")?.value?.trim();
  if (!text) {
    pulseFocusField($("#landing-input"));
    updateLandingSendState();
    return;
  }
  openNewCaseFlow();
  if ($("#simple-name")) $("#simple-name").value = text;
  if (region && $("#simple-region")) $("#simple-region").value = region;
  syncJurisdictionFromRegionLabel(region);
  const parsed = parseIntakeForCase(text);
  const presetId = onboardingPresetId();
  selectPresetId(presetId);
  const defaults = SIMPLE_PRESET_DEFAULTS[presetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const name = parsed.personLabel !== "Private case" ? parsed.personLabel : text;
  const intakeText = intakeTextForPreset(presetId, { name, region, alias: "" });
  syncSimpleFormToLegacyFields({
    intakeText,
    personLabel: name,
    pastedUrls: urlsFromText(text),
    jurisdiction: parsed.jurisdiction,
    authorityBasis: parsed.authorityBasis,
    riskLevel: defaults.riskLevel
  });
  renderIntakeInferencePreview();
  if ($("#landing-input")) $("#landing-input").value = "";
  if ($("#landing-location")) $("#landing-location").value = "";
  updateLandingSendState();
  filterDefaultWelcomeChat();
  addChat("user", region ? `${name} · ${region}` : name);
  render();
  $("#onboarding-preview-fields")?.scrollIntoView({ behavior: "smooth", block: "start" });
  await runOnboardingPreview();
}

function applyAgentIntakeTemplate(presetId) {
  const template = AGENT_INTAKE_TEMPLATES[presetId];
  if (!template) return;
  selectPresetId(presetId);
  const nameEl = $("#simple-name");
  const aliasEl = $("#simple-alias");
  const regionEl = $("#simple-region");
  const urlsEl = $("#simple-urls");
  if (nameEl) nameEl.value = template.name;
  if (aliasEl) aliasEl.value = template.alias || "";
  if (regionEl) regionEl.value = template.region || "";
  if (urlsEl) urlsEl.value = template.urls || "";
  const defaults = SIMPLE_PRESET_DEFAULTS[presetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const intakeText = intakeTextForPreset(presetId, {
    name: template.name,
    region: template.region,
    alias: template.alias
  });
  syncSimpleFormToLegacyFields({
    intakeText,
    personLabel: template.name,
    pastedUrls: (template.urls || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    jurisdiction: defaults.jurisdiction,
    authorityBasis: "self",
    riskLevel: defaults.riskLevel
  });
  addChat("user", template.chatLine);
  addChat(
    "agent",
    `${presentPreset({ id: presetId }).title} template loaded in the main form. Edit anything on the left, then tap Start cleanup.`
  );
  renderIntakeInferencePreview();
  render();
  pulseFocusField(nameEl);
}

function syncSimpleFormToLegacyFields(parsed) {
  const intakeField = $("#agent-intake");
  if (intakeField) intakeField.value = parsed.intakeText;
  const label = $("#person-label");
  if (label) label.value = parsed.personLabel;
  const jurisdiction = $("#jurisdiction");
  if (jurisdiction) jurisdiction.value = parsed.jurisdiction;
  const authority = $("#authority");
  if (authority) authority.value = parsed.authorityBasis;
  const risk = $("#risk-level");
  if (risk) risk.value = parsed.riskLevel;
  if (parsed.pastedUrls.length && $("#findings-paste-input")) {
    $("#findings-paste-input").value = parsed.pastedUrls.join("\n");
  }
}

function pulseFocusField(field) {
  if (!field) return;
  field.focus({ preventScroll: true });
  field.classList.add("intake-focus-pulse");
  window.setTimeout(() => field.classList.remove("intake-focus-pulse"), 1600);
}

function focusIntake() {
  const onboardingActive = $("#onboarding-region")?.classList.contains("active");
  const simpleName = $("#simple-name");
  if (onboardingActive && simpleName) {
    $("#onboarding-region")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => pulseFocusField(simpleName), 120);
    return;
  }
  const intake = $("#agent-intake");
  if (onboardingActive && intake) {
    $("#onboarding-region")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => pulseFocusField(intake), 120);
    return;
  }
  if (state.appOpen && state.currentCaseId) {
    state.dockOpen = true;
    render();
    $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => pulseFocusField($("#agent-input")), 120);
    return;
  }
  $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => pulseFocusField(intake || $("#agent-input")), 120);
}

function shouldShowRouteTab() {
  if (!state.currentCaseId || !currentCase()) return false;
  if (state.showRouteTab) return true;
  if (state.agentNext?.action === "select-preset") return true;
  if (!state.agentPlan) return true;
  if (state.selectedPresetId !== state.recommendedPresetId) return true;
  return false;
}

function revealRouteTab(options = {}) {
  state.showRouteTab = true;
  if (options.focusTab !== false) state.tab = "tasks";
  render();
}

function syncRouteTabVisibility() {
  const show = shouldShowRouteTab();
  document.querySelectorAll(".tab-route").forEach((tab) => {
    tab.hidden = !show;
  });
  const changeRoute = $("#change-route");
  if (changeRoute) changeRoute.hidden = !state.currentCaseId || show;
  if (!show && state.tab === "tasks") state.tab = "overview";
  if (show && state.agentNext?.action === "select-preset" && state.tab === "overview") {
    state.tab = "tasks";
  }
}

async function performGuidePrimaryAction() {
  const step = currentGuideStep();
  if (!state.appOpen) {
    openApp();
    return;
  }
  if (step === 1) {
    if (!state.currentCaseId) {
      await startSimpleCleanup();
      return;
    }
  }
  if (step === 2) {
    const pending = state.currentStatus?.pendingFindings?.length ?? 0;
    if (pending > 0) {
      $("#findings-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      render();
      return;
    }
    await agentAutopilot();
    return;
  }
  if (step === 3) {
    state.tab = "overview";
    state.dockOpen = true;
    render();
    return;
  }
  await agentAutopilot();
}

function renderUserGuide() {
  const guide = $("#user-guide");
  if (!guide) return;
  const step = currentGuideStep();
  const showDashboard =
    state.appOpen && Boolean(state.currentCaseId && currentCase() && state.currentStatus) && !state.preSearchReady;
  guide.hidden = !showDashboard;

  const lead = $("#guide-lead");
  if (lead) {
    const active = GUIDE_STEPS[step - 1];
    lead.textContent = showDashboard ? active.hint : "";
  }

  const toolbarMeta = $("#toolbar-case-meta");
  const toolbarStep = $("#toolbar-step-label");
  const showToolbar = state.appOpen && Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  if (toolbarMeta) toolbarMeta.hidden = !showToolbar;
  if (toolbarStep && showToolbar) {
    const caseLabel = currentCase()?.redactedScope?.personLabel || "Case";
    const stepTitle = GUIDE_STEPS[step - 1]?.title || "Working";
    toolbarStep.textContent = `${stepTitle} · ${caseLabel}`;
  }

  const stepsEl = $("#guide-steps");
  if (stepsEl) {
    stepsEl.innerHTML = GUIDE_STEPS.map((item) => {
      const status =
        item.num < step ? "done" : item.num === step ? "active" : "pending";
      return `<li class="guide-checkpoint ${status}" role="listitem" data-guide-step="${item.num}" title="${escapeHtml(item.hint)}">
        <span class="guide-checkpoint-num">Step ${item.num}</span>
        <span class="guide-checkpoint-label">${escapeHtml(item.title)}</span>
      </li>`;
    }).join("");
    bindIcons(stepsEl);
  }
  const progressTrack = $("#guide-progress-track");
  const progressFill = $("#guide-progress-fill");
  const progressPct = $("#guide-progress-pct");
  const pct = GUIDE_STEPS.length > 1 ? ((step - 1) / (GUIDE_STEPS.length - 1)) * 100 : 0;
  const pctLabel = `${Math.round(pct)}%`;
  if (progressTrack) {
    progressTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
    progressTrack.setAttribute(
      "aria-valuetext",
      `Progress ${pctLabel} — ${GUIDE_STEPS[step - 1]?.title || "Working"}`
    );
  }
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressPct) progressPct.textContent = pctLabel;
  const phaseStatus = $("#guide-phase-status");
  if (phaseStatus) phaseStatus.textContent = showDashboard ? workflowStatusLine() : "";
  syncRouteTabVisibility();
}

function write(value) {
  if (output) {
    output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  if (value?.caseStatus) {
    state.currentStatus = value.caseStatus;
    if (value.plan) state.agentPlan = value.plan;
    if (value.connectorResults) state.connectorResults = value.connectorResults;
    renderDashboard();
    renderAgentChat();
    renderApprovals();
    renderActions();
  }
}

function pillClass(value) {
  if (value === true || value === "pass" || value === "used" || value === "ready" || value === "executed" || value === "paid") {
    return "pill pass";
  }
  if (value === false || value === "fail" || value === "blocked") return "pill fail";
  return "pill warn";
}

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

function chipClass(value) {
  return pillClass(value).replace("pill", "chip");
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

const PRESET_PRESENTATION = {
  "people-search-cleanup": {
    title: "People-search",
    description: "Find profiles, draft removals, recheck later.",
    tags: ["Profiles", "Recheck", "Approval"]
  },
  "search-result-suppression": {
    title: "Search results",
    description: "Plan source deletion and Google suppression.",
    tags: ["Google", "Source first", "Handoff"]
  },
  "california-drop": {
    title: "California DROP",
    description: "Guide the official California deletion route.",
    tags: ["CA only", "Official", "90d"]
  },
  "gdpr-erasure": {
    title: "GDPR/UK",
    description: "Draft erasure requests and response tracking.",
    tags: ["EU/UK", "Controller", "1mo"]
  },
  "breach-exposure": {
    title: "Breach check",
    description: "Check exposure safely and focus on mitigation.",
    tags: ["HIBP", "Prefix-safe", "Mitigation"]
  },
  "high-risk-safety": {
    title: "Safety cleanup",
    description: "Prioritize urgent address and safety exposure.",
    tags: ["Priority", "Address", "Manual confirm"]
  }
};

function presentPreset(preset) {
  return PRESET_PRESENTATION[preset?.id] || {
    title: preset?.title || "Cleanup",
    description: preset?.summary || "Prepare cleanup actions.",
    tags: ["Approval"]
  };
}

function runtimeLabel(proof = state.trustProof) {
  if (proof?.verifierResult === "pass") return { text: "TEE verified", state: "pass" };
  if (proof?.verifierResult === "fail") return { text: "TEE blocked", state: "fail" };
  return { text: "Local mode", state: "warn" };
}

function teeQuestionIntent(lower) {
  return (
    /\b(tee|attestation|trust center|runtime proof|hardware quote|verify runtime)\b/.test(lower) ||
    lower.includes("view tee") ||
    lower.includes("verify tee")
  );
}

async function buildTeeVerificationBrief() {
  const proof = state.trustProof || (await refreshTrust());
  const privacy = state.privacy;
  const runtime = runtimeLabel(proof);
  const lines = [`Runtime: ${runtime.text}.`];
  if (proof) {
    lines.push(
      `Verifier result: ${proof.verifierResult || "unknown"}.`,
      `TEE quote verified: ${yesNo(proof.hardwareQuoteVerified)}.`,
      `Compose hash matches: ${yesNo(proof.composeHashMatches)}.`,
      `Image digests pinned: ${yesNo(proof.imageDigestsPinned)}.`,
      `Attestation fresh: ${yesNo(proof.attestationFresh)}.`
    );
    if (proof.errors?.length) {
      lines.push(`Open issues: ${proof.errors.slice(0, 3).join("; ")}.`);
    }
  } else {
    lines.push("Attestation proof is not loaded yet.");
  }
  if (privacy) {
    lines.push(`Server can decrypt vault: ${yesNo(privacy.serverCanDecryptCaseVault)} (should be no).`);
  }
  if (runtime.state === "pass") {
    lines.push("TEE is passing — sensitive connectors may run only after your explicit approval.");
  } else {
    lines.push("Sensitive connectors stay blocked until attestation passes. Open the Trust tab for the full proof JSON.");
  }
  return lines.join(" ");
}

function parseIntakeForCase(intakeText) {
  const text = String(intakeText || "").trim();
  const lower = text.toLowerCase();
  let jurisdiction = "US";
  if (/\b(uk|united kingdom|britain|england|scotland|wales)\b/.test(lower)) jurisdiction = "UK";
  else if (/\b(eu|europe|european|gdpr|ireland|germany|france)\b/.test(lower)) jurisdiction = "EU";

  let riskLevel = "standard";
  if (/(stalking|safety|current address|minor|work|school|urgent|harassment)/.test(lower)) {
    riskLevel = "high-risk-safety";
  }

  let authorityBasis = "self";
  if (/(guardian|minor child|my child)/.test(lower)) authorityBasis = "minor-guardian";
  else if (/(estate|deceased|death of)/.test(lower)) authorityBasis = "estate";
  else if (/(survivor|family member passed)/.test(lower)) authorityBasis = "survivor";
  else if (/(authorized representative|on behalf of)/.test(lower)) authorityBasis = "authorized-representative";

  const personLabel = personLabelFromIntake(text);

  return { intakeText: text, jurisdiction, riskLevel, authorityBasis, personLabel };
}

function personLabelFromIntake(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "Private case";
  const forMatch = trimmed.match(/\b(?:for|of)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\b/);
  if (forMatch) return forMatch[1].trim();
  return trimmed.length > 52 ? `${trimmed.slice(0, 49).trim()}…` : trimmed;
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;

function urlsFromText(text) {
  return [...new Set((String(text || "").match(URL_IN_TEXT_RE) || []).map((item) => item.trim()))];
}

function pastedUrlsFromFindingsInput() {
  const raw = $("#findings-paste-input")?.value || "";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function discoveryUrlHints() {
  const fromPaste = pastedUrlsFromFindingsInput();
  if (fromPaste.length) return fromPaste;
  const fromSimple = ($("#simple-urls")?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (fromSimple.length) return fromSimple;
  const fromIntake = urlsFromText(state.intakeText || $("#agent-intake")?.value || "");
  if (fromIntake.length) return fromIntake;
  if (!state.currentCaseId) return [];
  try {
    const stored = localStorage.getItem(`oblivion.discoveryUrls.${state.currentCaseId}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function peopleSearchPresetActive() {
  const presetId = state.agentPlan?.presetId || state.selectedPresetId;
  return (
    presetId === "people-search-cleanup" ||
    presetId === "high-risk-safety" ||
    presetId === "content-takedown"
  );
}

function brokerSubmissionBadge(finding) {
  if (!finding.submissionMethod) return "";
  const mode = finding.teeAutomatable ? "automatable" : "handoff";
  return `<span class="pill small">${escapeHtml(finding.submissionMethod)} · ${mode}</span>`;
}

function needsExposureDiscovery() {
  const step = state.agentNext?.action || state.agentPlan?.currentStep;
  const blocked = state.agentNext?.blockedReasons || state.agentPlan?.blockedReasons || [];
  if (step !== "discover-candidates" && !blocked.includes("discovery-needed")) return false;
  const pending = state.currentStatus?.pendingFindings?.length ?? 0;
  const total = state.currentStatus?.findings?.length ?? 0;
  return pending === 0 && total === 0;
}

function presetUsesBrokerDiscoveryClient(presetId) {
  return presetId === "people-search-cleanup" || presetId === "high-risk-safety";
}

function presetUsesContentDiscoveryClient(presetId) {
  return presetId === "content-takedown";
}

function renderDiscoveryPlan() {
  const section = $("#findings-discovery");
  const planEl = $("#findings-discovery-plan");
  const statusEl = $("#findings-discovery-status");
  const discoverBtn = $("#findings-discover");
  if (!section || !planEl) return;

  const hasCase = Boolean(state.currentCaseId && state.currentStatus);
  section.hidden = !hasCase;
  if (!hasCase) return;

  const plan = state.discoveryPlan;
  const reviewables = (state.currentStatus?.findings || []).filter((item) => item.matchStatus !== "rejected");

  if (!plan) {
    planEl.innerHTML = state.discoveryBusy
      ? `<p class="findings-discovery-summary muted small">Loading discovery plan…</p>`
      : `<p class="findings-discovery-summary muted small">Discovery plan will appear after you run Discover listings.</p>`;
    if (discoverBtn) {
      discoverBtn.disabled = state.discoveryBusy;
      setButtonLabel(
        discoverBtn,
        state.discoveryBusy
          ? "Searching…"
          : reviewables.length
            ? "Search again"
            : "Discover listings"
      );
    }
    if (statusEl) {
      statusEl.textContent = state.discoveryBusy ? "Running broker sweep and web search…" : "";
    }
    return;
  }
  const onReviewStep =
    currentGuideStep() === 2 ||
    state.agentPlan?.currentStep === "discover-candidates" ||
    state.agentPlan?.currentStep === "confirm-matches" ||
    (state.agentNext?.blockedReasons || []).includes("discovery-needed");

  planEl.innerHTML = `
    <p class="findings-discovery-summary muted small">${escapeHtml(plan.summary)}</p>
    <ol class="findings-discovery-methods" role="list">
      ${plan.methods
        .map(
          (method) => `
        <li class="findings-discovery-method ${method.enabled ? "" : "disabled"}" role="listitem">
          <strong>${escapeHtml(method.label)}</strong>
          <span class="muted small">${escapeHtml(method.detail)}</span>
        </li>`
        )
        .join("")}
    </ol>`;

  if (discoverBtn) {
    discoverBtn.disabled = state.discoveryBusy;
    setButtonLabel(
      discoverBtn,
      state.discoveryBusy
        ? "Searching…"
        : reviewables.length
          ? "Search again"
          : "Discover listings"
    );
  }

  if (statusEl) {
    statusEl.textContent = state.discoveryBusy
      ? "Running broker sweep and web search…"
      : !plan.canAutoDiscover
        ? "Add profile URLs below, then tap Discover listings."
        : "";
  }
}

function openFindingsPastePanel() {
  const details = $("#findings-paste-details");
  if (details && !details.open) details.open = true;
  pulseFocusField($("#findings-paste-input"));
}

function applyParsedIntakeToForm(parsed) {
  const intakeField = $("#agent-intake");
  const legacyIntake = $("#intake");
  if (intakeField) intakeField.value = parsed.intakeText;
  if (legacyIntake) legacyIntake.value = parsed.intakeText;
  const label = $("#person-label");
  if (label) label.value = parsed.personLabel;
  const jurisdiction = $("#jurisdiction");
  if (jurisdiction) jurisdiction.value = parsed.jurisdiction;
  const authority = $("#authority");
  if (authority) authority.value = parsed.authorityBasis;
  const risk = $("#risk-level");
  if (risk) risk.value = parsed.riskLevel;
}

function renderIntakeInferencePreview() {
  const preview = $("#intake-inference-preview");
  const raw = $("#agent-intake")?.value?.trim();
  if (!preview) return;
  if (!raw) {
    preview.textContent = "Jurisdiction and route are inferred when you start.";
    return;
  }
  const parsed = parseIntakeForCase(raw);
  const presetId = recommendPreset(parsed);
  preview.textContent = `I’ll use ${parsed.jurisdiction} · ${parsed.riskLevel === "high-risk-safety" ? "safety route" : "standard"} · route: ${presetTitle(presetId)}.`;
}

function recommendPreset(input) {
  const text = `${input.intakeText || ""} ${input.riskLevel || ""}`.toLowerCase();
  const jurisdiction = input.jurisdiction;
  if (/(stalking|safety|current address|minor|work|school)/.test(text)) return "high-risk-safety";
  if (/(drop|california|\bca\b)/.test(text) && jurisdiction === "US") return "california-drop";
  if (/(gdpr|erasure|controller|\buk\b|\beu\b)/.test(text) && ["EU", "UK"].includes(jurisdiction)) return "gdpr-erasure";
  if (/(breach|password|email leak|leaked email)/.test(text)) return "breach-exposure";
  if (/(takedown|dmca|copyright|onlyfans|fanvue|leaked video|stolen content|infringing)/.test(text)) {
    return "content-takedown";
  }
  if (/google/.test(text)) return "search-result-suppression";
  if (/(people-search|people search|profile|address)/.test(text)) return "people-search-cleanup";
  if (/(search|result)/.test(text)) return "search-result-suppression";
  return jurisdiction === "EU" || jurisdiction === "UK" ? "gdpr-erasure" : "people-search-cleanup";
}

function selectedPreset() {
  return state.presets.find((preset) => preset.id === state.selectedPresetId) || null;
}

function inputPrivacyValue(id) {
  const el = document.getElementById(id);
  if (!el || !("value" in el)) return "";
  return el.dataset.privacyRealValue ?? el.value ?? "";
}

function collectPrivacyTerms() {
  const scope = currentCase()?.redactedScope;
  const extras = [
    inputPrivacyValue("simple-name"),
    inputPrivacyValue("simple-alias"),
    inputPrivacyValue("simple-region"),
    state.intakeText,
    inputPrivacyValue("agent-intake"),
    inputPrivacyValue("intake")
  ].filter(Boolean);
  const label =
    scope?.personLabel ||
    personLabelFromIntake(state.intakeText || $("#agent-intake")?.value || "") ||
    inputPrivacyValue("simple-name")?.trim();
  return expandNameTerms(label, scope?.aliases || [], [
    scope?.region,
    ...(scope?.approvedIdentifierLabels || []),
    ...extras
  ]);
}

function displayPlainText(value) {
  const text = String(value ?? "");
  if (!state.privacyFilterMode) return text;
  return maskPrivacyText(text, collectPrivacyTerms());
}

function escapeHtml(value) {
  return displayPlainText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function renderPrivacyFilterSettings() {
  const toggle = $("#privacy-filter-toggle");
  if (toggle) toggle.checked = Boolean(state.privacyFilterMode);
}

function renderAgentVoiceSettings() {
  const toggle = $("#agent-voice-toggle");
  if (toggle) toggle.checked = Boolean(state.agentVoiceEnabled);
}

function renderChatBubble(message) {
  const role = message.role === "user" ? "user" : "agent";
  const animate = role === "agent" && message.animate && message.text;
  const bodyText = animate ? "" : escapeHtml(message.text);
  const bodyAttrs = animate ? ` data-typewriter-text="${escapeHtml(message.text)}"` : "";
  const rowAttrs = message.id != null ? ` data-chat-msg-id="${message.id}"` : "";
  const body = `<div class="chat-bubble ${role}${animate ? " chat-bubble-typing" : ""}"${bodyAttrs}>${bodyText}</div>`;
  if (role === "user") {
    return `<div class="chat-row user" data-chat-role="user"${rowAttrs}>${body}</div>`;
  }
  const avatar = `<span class="chat-avatar chat-avatar-agent" title="Agent" aria-label="Agent"><img src="/assets/oblivion-agent-pfp.jpg" alt="" width="36" height="36" /></span>`;
  return `<div class="chat-row agent" data-chat-role="agent"${rowAttrs}>${avatar}${body}</div>`;
}

function cancelChatTypewriters() {
  chatTypewriterTimers.forEach((timer) => window.clearTimeout(timer));
  chatTypewriterTimers = [];
  stopAgentVoice();
}

function runChatTypewriters(log, logShell) {
  cancelChatTypewriters();
  log.querySelectorAll("[data-typewriter-text]").forEach((bubble) => {
    const fullText = bubble.dataset.typewriterText || "";
    const row = bubble.closest("[data-chat-msg-id]");
    const msgId = row ? Number(row.dataset.chatMsgId) : NaN;
    let index = 0;
    const step = () => {
      bubble.textContent = fullText.slice(0, index);
      if (index > 0) playCharBeep(fullText[index - 1]);
      if (logShell) logShell.scrollTop = logShell.scrollHeight;
      if (index < fullText.length) {
        index += 1;
        const delay = fullText.length > 160 ? 8 : fullText.length > 80 ? 12 : 18;
        chatTypewriterTimers.push(window.setTimeout(step, delay));
      } else {
        bubble.classList.remove("chat-bubble-typing");
        bubble.removeAttribute("data-typewriter-text");
        const msg = state.chatMessages.find((item) => item.id === msgId);
        if (msg) msg.animate = false;
      }
    };
    step();
  });
}

function saveLocalCases() {
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

function loadLocalCases() {
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

async function refreshTrust() {
  const [proof, privacy] = await Promise.all([
    request("/api/trust/attestation"),
    request("/api/trust/privacy")
  ]);
  state.trustProof = proof;
  state.privacy = privacy;
  renderTrust();
  return proof;
}

function syncAppRoute() {
  state.appOpen = location.hash === "#app";
}

async function refreshCases() {
  state.cases = loadLocalCases();
  if (state.appOpen && state.currentCaseId) {
    await loadCase(state.currentCaseId, { silent: true, openApp: false });
  } else {
    await refreshAgentPlan({ silent: true }).catch(() => {});
    await refreshHackathon({ silent: true }).catch(() => {});
    render();
  }
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
  if (!options.silent) write(result);
}

async function loadCase(caseId, options = {}) {
  if (options.openApp !== false) {
    state.appOpen = true;
    state.dockOpen = true;
    state.dockPinned = true;
    location.hash = "app";
  }
  state.currentCaseId = caseId;
  localStorage.setItem("oblivion.currentCaseId", caseId);
  try {
    const loaded = await request(`/api/cases/${caseId}`);
    state.currentStatus = loaded.status;
    const index = state.cases.findIndex((item) => item.id === caseId);
    const summary = { ...loaded.case, status: loaded.status };
    if (index >= 0) state.cases[index] = summary;
    else state.cases.unshift(summary);
    saveLocalCases();
    if (!options.silent) write(loaded);
    await refreshAgentPlan({ silent: true }).catch(() => {});
    await refreshHackathon({ silent: true }).catch(() => {});
    state.onboardingPreviewReady = false;
    if (state.currentStatus && !caseIsActivated()) {
      state.preSearchReady = false;
      resetPreSearchUi();
    }
  } catch (error) {
    state.currentStatus = null;
    if (error?.error === "case-not-found") {
      state.cases = state.cases.filter((item) => item.id !== caseId);
      state.currentCaseId = "";
      localStorage.removeItem("oblivion.currentCaseId");
      saveLocalCases();
      const replacement = state.appOpen ? state.cases[0] : null;
      if (replacement) {
        await loadCase(replacement.id, { silent: options.silent });
        return;
      }
    }
    if (!options.silent) write(error);
  }
  updateSessionHandoffWarning();
  render();
}

if (typeof window !== "undefined") {
  window.__oblivionLoadCase = loadCase;
}

function currentCase() {
  return state.cases.find((item) => item.id === state.currentCaseId) || null;
}

function renderTrust() {
  const proof = state.trustProof;
  const privacy = state.privacy;
  if (!proof || !privacy) return;
  const runtime = runtimeLabel(proof);
  const trustStrip = $("#trust-strip");
  if (trustStrip) {
    trustStrip.innerHTML = `
      <span class="chip pass" data-testid="trust-vault" data-icon="lock" title="Vault locked">Vault</span>
      <span class="${chipClass(!privacy.serverCanDecryptCaseVault)}" data-testid="trust-server" data-icon="eye-closed" title="Server blind">Blind</span>
      <span class="${chipClass(runtime.state)}" data-testid="trust-runtime" data-icon="cast" title="${escapeHtml(runtime.text)}">${escapeHtml(runtime.text)}</span>
    `;
  }
  const teeClass = pillClass(runtime.state);
  const teeNodes = ["#tee-status", "#command-tee-status", "#trust-tab-status"].map((sel) => $(sel)).filter(Boolean);
  teeNodes.forEach((node) => {
    node.className = teeClass;
    node.textContent = runtime.text;
  });
  $("#runtime-summary").innerHTML = `
    <div class="status-row"><span>Vault</span><strong>locked</strong></div>
    <div class="status-row"><span>Server</span><strong>blind</strong></div>
    <div class="status-row"><span>Runtime</span><strong>${runtimeLabel(proof).text}</strong></div>
  `;
  $("#trust-details").innerHTML = `
    <div class="status-row"><span>TEE quote</span><strong>${yesNo(proof.hardwareQuoteVerified)}</strong></div>
    <div class="status-row"><span>Compose hash</span><strong>${yesNo(proof.composeHashMatches)}</strong></div>
    <div class="status-row"><span>Image digests</span><strong>${yesNo(proof.imageDigestsPinned)}</strong></div>
    <div class="status-row"><span>Server can decrypt vault</span><strong>${yesNo(privacy.serverCanDecryptCaseVault)}</strong></div>
  `;
  $("#trust-output").textContent = JSON.stringify({ proof, privacy }, null, 2);
}

function formatCaseDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function toggleCasesPanel(open) {
  if (typeof open === "boolean") state.casesPanelOpen = open;
  else state.casesPanelOpen = !state.casesPanelOpen;
  renderCases();
}

function openNewCaseFlow() {
  state.appOpen = true;
  state.dockOpen = true;
  state.dockPinned = true;
  location.hash = "app";
  state.currentCaseId = "";
  state.currentStatus = null;
  state.agentPlan = null;
  state.connectorResults = [];
  state.recommendedPresetId = onboardingPresetId();
  state.selectedPresetId = onboardingPresetId();
  state.showRouteTab = false;
  const jurisdiction = $("#jurisdiction");
  const authority = $("#authority");
  const risk = $("#risk-level");
  const autonomy = $("#high-autonomy-toggle");
  if (jurisdiction) jurisdiction.value = "US";
  if (authority) authority.value = "self";
  if (risk) risk.value = "standard";
  if (autonomy) autonomy.checked = false;
  state.casesPanelOpen = false;
  resetPreSearchUi();
  state.onboardingPreviewReady = false;
  state.onboardingPreviewBusy = false;
  localStorage.removeItem("oblivion.currentCaseId");
  ["simple-name", "simple-alias", "simple-region", "simple-urls"].forEach((id) => {
    const field = $(`#${id}`);
    if (field) field.value = "";
  });
  const statusEl = $("#simple-start-status");
  if (statusEl) statusEl.textContent = "";
  focusIntake();
  render();
}

function renderCases() {
  const list = $("#case-list");
  if (!list) return;

  if (state.cases.length === 0) {
    list.innerHTML = `<div class="empty case-empty">No cases yet. Tap New case to start a cleanup.</div>`;
    return;
  }

  list.innerHTML = state.cases.map((item) => {
    const label = item.redactedScope?.personLabel || item.id.slice(0, 14);
    const active = item.id === state.currentCaseId ? " active" : "";
    const updated = formatCaseDate(item.updatedAt);
    const meta = [item.jurisdiction, item.riskLevel, updated].filter(Boolean).join(" · ");
    return `
      <div class="case-row${active}" data-case-row="${item.id}">
        <button type="button" class="case-button${active}" data-case-id="${item.id}" title="${escapeHtml(meta)}">
          <span class="case-button-label">${escapeHtml(label)}</span>
          <span class="case-button-meta muted small">${escapeHtml(meta)}</span>
        </button>
        <button type="button" class="ghost compact icon-only case-delete-btn" data-delete-case="${item.id}" data-icon="delete" aria-label="Delete ${escapeHtml(label)}"><span class="btn-label">Delete</span></button>
      </div>
    `;
  }).join("");
  bindIcons(list);
}

function workflowStatusLine() {
  const pending = state.currentStatus?.pendingFindings?.length || 0;
  const approvals = state.currentStatus?.approvalsNeeded?.length || 0;
  let statusLine = state.agentNext?.message || state.agentPlan?.nextUserDecision || "";
  if (pending > 0) statusLine = `${pending} listing(s) need your answer.`;
  if (approvals > 0) statusLine = "Approval required before anything is sent.";
  if (state.autopilotBusy) statusLine = "Running cleanup…";
  return statusLine;
}

function renderShell() {
  const hasCase = Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  const app = $(".app");
  const chrome = $("#app-chrome");
  const agentColumn = $("#app-agent-column");
  const workspace = $("#app-workspace");
  $("#landing-region")?.classList.toggle("hidden", state.appOpen);
  app?.classList.toggle("app-workspace-open", state.appOpen);
  if (chrome) {
    chrome.hidden = !state.appOpen;
    chrome.classList.toggle("active", state.appOpen);
    chrome.classList.toggle("agent-collapsed", state.appOpen && !state.dockPinned);
    chrome.classList.toggle("sidebar-collapsed", state.appOpen && !state.sidebarOpen);
  }
  const sidebarCollapse = $("#sidebar-collapse");
  if (sidebarCollapse) {
    sidebarCollapse.setAttribute("aria-expanded", state.sidebarOpen ? "true" : "false");
    sidebarCollapse.setAttribute("aria-label", state.sidebarOpen ? "Collapse sidebar" : "Expand sidebar");
    setIcon(sidebarCollapse, "pixel:bars-solid");
  }
  workspace?.classList.toggle("simple-mode", !state.showAdvancedUI);
  agentColumn?.classList.toggle("collapsed", state.appOpen && !state.dockPinned);
  const activated = caseIsActivated();
  const showOnboarding = state.appOpen && (!hasCase || !activated || state.preSearchReady);
  const showDashboard = state.appOpen && hasCase && activated && !state.preSearchReady;
  $("#onboarding-region")?.classList.toggle("active", showOnboarding);
  $("#dashboard-region")?.classList.toggle("active", showDashboard);
  applyAdvancedUiVisibility();
  const dockCollapse = $("#agent-dock-collapse");
  if (dockCollapse) {
    dockCollapse.setAttribute("aria-expanded", state.dockPinned ? "true" : "false");
    dockCollapse.setAttribute("aria-label", state.dockPinned ? "Hide agent panel" : "Show agent panel");
    setButtonLabel(dockCollapse, state.dockPinned ? "Hide" : "Show");
    dockCollapse.classList.toggle("agent-dock-collapse--pinned", state.dockPinned);
    setIcon(dockCollapse, "pixel:plus-solid");
  }
  $("#agent-dock")?.classList.toggle("agent-dock-expanded", state.dockPinned);
}

function renderDashboard() {
  const caseRecord = currentCase();
  const status = state.currentStatus;
  if (!caseRecord) return;
  const label = caseRecord.redactedScope?.personLabel || "Private case";
  $("#case-heading").textContent = displayPlainText(label);
  const subtitle = $("#case-subtitle");
  if (subtitle) {
    subtitle.textContent = `${presetTitle(state.agentPlan?.presetId) || "Cleanup"} · encrypted locally`;
  }

  const approvals = status?.approvalsNeeded?.length || 0;
  const ready = status?.actionsReady?.length || 0;
  const submitted = status?.submittedActions?.length || 0;
  const pending = status?.pendingFindings?.length || 0;
  const guideStep = currentGuideStep();
  const stepLabel = $("#current-step-label");
  if (stepLabel) stepLabel.textContent = GUIDE_STEPS[guideStep - 1]?.title || "Working";
  const nextPill = $("#next-action-pill");
  if (nextPill) nextPill.textContent = approvals > 0 ? "Approve" : pending > 0 ? "Review" : "Running";
  const nextCopy = $("#next-action-copy");
  if (nextCopy) {
    nextCopy.textContent = approvals > 0
      ? "Nothing sends until you approve."
      : pending > 0
        ? "Confirm your listings below."
        : "Agent is preparing opt-out requests.";
  }
  if (state.showAdvancedUI) {
    $("#case-glance").innerHTML = `
      <div class="status-row"><span>Approvals</span><strong>${approvals}</strong></div>
      <div class="status-row"><span>Ready</span><strong>${ready}</strong></div>
      <div class="status-row"><span>Recorded</span><strong>${submitted}</strong></div>
    `;
    const runtime = runtimeLabel();
    $("#ops-strip").innerHTML = `
      <div class="metric"><span>Runtime</span><strong>${runtime.text}</strong></div>
      <div class="metric"><span>Agent</span><strong>${state.agentNext ? shortStepTitle(state.agentNext.title) : "…"}</strong></div>
    `;
    $("#agent-context").innerHTML = `
      <div class="agent-line"><span>Preset</span><strong>${escapeHtml(presetTitle(state.agentPlan?.presetId) || "—")}</strong></div>
    `;
  }
  renderCleanupProgress();
}

function renderCleanupProgress() {
  const bar = $("#cleanup-progress");
  if (!bar) return;
  if (!state.agentPlan) {
    bar.innerHTML = "";
    return;
  }
  const statusLine = workflowStatusLine();
  const step = state.agentPlan.currentStep;
  const order = WORKFLOW_PHASES.map((phase) => phase.id);
  const index = Math.max(0, order.indexOf(step));
  bar.innerHTML = `
    <div class="progress-phases">
      ${WORKFLOW_PHASES.slice(0, 7)
        .map((phase, i) => {
          const done = i < index;
          const active = phase.id === step;
          return `<span class="progress-phase ${done ? "done" : ""} ${active ? "active" : ""}">${escapeHtml(phase.label)}</span>`;
        })
        .join("")}
    </div>
    <p class="muted small progress-status">${escapeHtml(statusLine)}</p>
  `;
}

function matchScorePill(score) {
  if (score === "likely") return "pass";
  if (score === "unlikely") return "blocked";
  return "warn";
}

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 28)}…` : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url.length > 42 ? `${url.slice(0, 42)}…` : url;
  }
}

function renderFindings() {
  const panel = $("#findings-panel");
  if (!panel) return;
  const status = state.currentStatus;
  const hasCase = Boolean(state.currentCaseId && status);
  panel.hidden = !hasCase;
  if (!hasCase) return;

  const pending = status.pendingFindings?.length ?? 0;
  const confirmed = status.confirmedFindings?.length ?? 0;
  const pill = $("#findings-count-pill");
  if (pill) {
    pill.textContent = pending > 0 ? `${pending} pending` : `${confirmed} confirmed`;
    pill.className = `pill ${pending > 0 ? "warn" : confirmed > 0 ? "pass" : ""}`.trim();
  }

  const hint = $("#findings-hint");
  if (hint) {
    hint.textContent =
      pending > 0
        ? "Yes = yours · Not me = skip"
        : confirmed > 0
          ? "Queued for removal after you approve."
          : "Tap Discover listings to search, or paste URLs you already know.";
  }

  renderDiscoveryPlan();

  const list = $("#findings-list");
  const reviewables = (status.findings || []).filter((item) => item.matchStatus !== "rejected");
  if (list) {
    list.innerHTML = reviewables.length
      ? reviewables
          .map((finding) => {
            const pendingRow = (finding.matchStatus ?? "pending") === "pending";
            return `
        <article class="finding-card" data-finding-id="${finding.id}" data-testid="finding-card">
          <div class="finding-card-head">
            <strong>${escapeHtml(finding.brokerLabel || "Listing")}</strong>
            <span class="pill ${pillClass(matchScorePill(finding.matchScore))}">${escapeHtml(finding.matchScore || "uncertain")}</span>
            ${brokerSubmissionBadge(finding)}
          </div>
          <a class="finding-url" href="${escapeHtml(finding.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortenUrl(finding.sourceUrl))}</a>
          ${
            state.showAdvancedUI
              ? `<p class="muted small">${escapeHtml(finding.matchReason || finding.redactedSnippet || "Candidate")}</p>`
              : ""
          }
          ${
            pendingRow
              ? `<div class="finding-actions">
            <button type="button" class="secondary compact" data-finding-confirm="${finding.id}" data-testid="finding-confirm" data-icon="check">Confirm</button>
            <button type="button" class="ghost compact" data-finding-reject="${finding.id}" data-testid="finding-reject" data-icon="close">Not me</button>
          </div>`
              : `<span class="pill ${finding.matchStatus === "confirmed" ? "pass" : ""}">${escapeHtml(finding.matchStatus || "pending")}</span>`
          }
        </article>`;
          })
          .join("")
      : `<div class="empty">No links yet. Tap <strong>Discover listings</strong> above to search brokers and the web, or paste URLs you already know.</div>`;
  }

  const queue = $("#removal-queue");
  const queueList = $("#removal-queue-list");
  const confirmedRows = status.confirmedFindings || [];
  if (queue) queue.hidden = confirmedRows.length === 0;
  if (queueList) {
    queueList.innerHTML = confirmedRows.length
      ? confirmedRows
          .map(
            (finding) => `
        <div class="finding-queue-row">
          <div>
            <strong>${escapeHtml(finding.brokerLabel || shortenUrl(finding.sourceUrl))}</strong>
            <div class="muted small">${escapeHtml(finding.removalStatus || "not-started")}${finding.submissionMethod ? ` · ${finding.submissionMethod}` : ""}</div>
          </div>
          ${
            finding.officialOptOutUrl
              ? `<a class="ghost compact" href="${escapeHtml(finding.officialOptOutUrl)}" target="_blank" rel="noopener noreferrer" data-icon="link">Opt out</a>`
              : ""
          }
        </div>`
          )
          .join("")
      : "";
  }
}

function discoverySearchReady() {
  const live = state.integrationsStatus?.liveReady;
  return Boolean(live?.veniceSearch || live?.braveSearch);
}

async function maybeAutoDiscoverFindings(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!options.force && (!peopleSearchPresetActive() || !needsExposureDiscovery())) {
    return { ran: false, reason: "not-needed" };
  }
  const pastedUrls = discoveryUrlHints();
  const searchReady = discoverySearchReady();
  if (!pastedUrls.length && !searchReady) {
    if (!options.quiet) {
      openFindingsPastePanel();
      addChat("agent", "Automated search is off — paste profile URLs in the review panel, then tap Discover listings.");
    }
    return { ran: false, reason: "urls-needed" };
  }
  state.discoveryBusy = true;
  renderDiscoveryPlan();
  try {
    const result = await request(`/api/cases/${state.currentCaseId}/findings/discover`, {
      method: "POST",
      body: {
        pastedUrls,
        walletAddress: state.walletAddress || undefined
      }
    });
    state.discoveryPlan = result.discoveryPlan ?? null;
    state.currentStatus = result.status ?? (await request(`/api/cases/${state.currentCaseId}`)).status;
    if (pastedUrlsFromFindingsInput().length && $("#findings-paste-input")) {
      $("#findings-paste-input").value = "";
    }
    if (pastedUrls.length) {
      localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(pastedUrls));
    }
    await refreshAgentPlan({ silent: true }).catch(() => {});
    await refreshHackathon({ silent: true }).catch(() => {});
    if (!options.quiet) {
      addChat(
        "agent",
        result.discovered?.length
          ? `Found ${result.discovered.length} link(s) to review.`
          : "No new links — try pasting URLs or configure Brave search."
      );
      write(result);
    }
    return { ran: true, discovered: result.discovered?.length ?? 0, result };
  } finally {
    state.discoveryBusy = false;
  }
}

async function discoverFindings() {
  assertCaseActivatedClient();
  await refreshIntegrationsStatus().catch(() => {});
  try {
    const discovery = await maybeAutoDiscoverFindings({ force: true, quiet: false });
    if (!discovery.ran && discovery.reason === "urls-needed") {
      throw { error: "urls-required", message: "Paste at least one profile URL, or enable Brave search on the server." };
    }
    if (discovery.ran && !discovery.discovered) {
      await syncCurrentCaseStatus();
    }
    render();
  } catch (error) {
    state.discoveryBusy = false;
    renderDiscoveryPlan();
    throw error;
  }
}

async function decideFinding(findingId, decision) {
  if (!state.currentCaseId) return;
  const result = await request(`/api/cases/${state.currentCaseId}/findings/${findingId}/${decision}`, {
    method: "POST",
    body: {}
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {});
  render();
  addChat("agent", decision === "confirm" ? "Marked as your listing." : "Marked as not you.");
}

function presetTitle(presetId) {
  const preset = state.presets.find((item) => item.id === presetId);
  return preset ? presentPreset(preset).title : "";
}

function titleForAction(action) {
  return {
    "select-preset": "Choose cleanup preset",
    "collect-minimum-identifiers": "Collect minimum identifiers",
    "verify-trust": "Verify runtime trust",
    "discover-candidates": "Discover exposure candidates",
    "confirm-matches": "Confirm matches",
    "verify-removal-path": "Verify removal path",
    "draft-actions": "Draft actions",
    "request-approval": "Approval required",
    "execute-approved-action": "Execute approved action",
    "await-confirmation": "Await confirmation",
    "schedule-recheck": "Schedule recheck",
    "escalate-if-needed": "Escalate if needed",
    "complete": "Cleanup cycle complete"
  }[action] || action || "Choose cleanup preset";
}

function renderPresets() {
  const caseRecord = currentCase();
  const presets = state.presets.length ? state.presets : [];
  const grid = $("#preset-grid");
  if (!grid) return;
  grid.innerHTML = presets.map((preset) => {
    const blocked = caseRecord && !preset.jurisdictions.includes(caseRecord.jurisdiction);
    const active = preset.id === state.selectedPresetId;
    const recommended = preset.id === state.recommendedPresetId;
    const display = presentPreset(preset);
    return `
      <button class="preset-card" data-preset-id="${preset.id}" ${active ? 'data-active="true"' : ''} ${recommended ? 'data-recommended="true"' : ''} ${blocked ? "disabled" : ""} data-testid="preset-card">
        <div>
          ${recommended ? `<span class="pill pass recommended-badge">Recommended</span>` : ""}
          <strong>${escapeHtml(display.title)}</strong>
          <div class="muted small">${escapeHtml(display.description)}</div>
        </div>
        <div class="preset-meta">
          ${display.tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </button>
    `;
  }).join("") || `<div class="empty">Loading cleanup presets.</div>`;
  const selected = selectedPreset();
  const selectedDisplay = presentPreset(selected);
  const startPreset = $("#start-preset");
  if (startPreset) {
    startPreset.textContent = state.selectedPresetId === state.recommendedPresetId
      ? "Start recommended route"
      : "Start selected route";
  }
  const routeDetails = $("#route-details");
  if (!routeDetails) return;
  routeDetails.innerHTML = selected
    ? `
        <div class="status-row"><span>Route</span><strong>${escapeHtml(selectedDisplay.title)}</strong></div>
        <div class="status-row"><span>Needs</span><strong>${escapeHtml(selected.requiredIdentifierCategories.join(", "))}</strong></div>
        <div class="status-row"><span>Window</span><strong>${escapeHtml(selected.expectedWindow)}</strong></div>
        <div class="status-row"><span>Disclosure</span><strong>${escapeHtml(selected.disclosurePoints.join(", "))}</strong></div>
      `
    : `<div class="empty">Select a route to see details.</div>`;
  // Delegation handles clicks (see setupDelegates)
}

async function refreshCreditsBalance() {
  if (!state.walletAddress) {
    state.creditsBalance = null;
    return null;
  }
  try {
    const view = await request(`/api/credits/balance?walletAddress=${encodeURIComponent(state.walletAddress)}`);
    state.creditsBalance = view;
    return view;
  } catch {
    state.creditsBalance = null;
    return null;
  }
}

async function refreshHackathon(options = {}) {
  const products = await request("/api/x402/products");
  state.products = products.products || [];
  state.creditRates = products.credits || null;
  await refreshCreditsBalance().catch(() => {});
  if (state.currentCaseId && state.walletAddress) {
    try {
      state.aiEntitlement = await request(
        `/api/cases/${state.currentCaseId}/ai-entitlement?walletAddress=${encodeURIComponent(state.walletAddress)}`
      );
    } catch {
      state.aiEntitlement = null;
    }
  } else {
    state.aiEntitlement = null;
  }
  if (!state.currentCaseId) {
    state.hackathon = null;
    state.hackathonStatus = null;
    return;
  }
  const [timeline, checklist] = await Promise.all([
    request(`/api/agents/timeline?caseId=${state.currentCaseId}`),
    request(`/api/hackathon/status?caseId=${state.currentCaseId}`)
  ]);
  const next = await request(`/api/agent/next?caseId=${state.currentCaseId}`);
  state.hackathon = timeline;
  state.hackathonStatus = checklist.status;
  state.hackathonPending = checklist.pending || [];
  state.agentNext = next;
  if (!options.silent) write({ products, timeline, checklist });
}

async function syncCurrentCaseStatus() {
  if (!state.currentCaseId) return;
  const loaded = await request(`/api/cases/${state.currentCaseId}`);
  state.currentStatus = loaded.status;
  const index = state.cases.findIndex((item) => item.id === state.currentCaseId);
  const summary = { ...loaded.case, status: loaded.status };
  if (index >= 0) state.cases[index] = summary;
  else state.cases.unshift(summary);
  saveLocalCases();
}

function addChat(role, text, options = {}) {
  if (role === "agent") {
    state.chatMessages.forEach((item) => {
      if (item.role === "agent") item.animate = false;
    });
  }
  const animate = role === "agent" && options.animate !== false;
  state.chatMessages.push({
    id: ++chatMessageSeq,
    role,
    text,
    animate
  });
  state.chatMessages = state.chatMessages.slice(-24);
}

function shortStepTitle(title) {
  return {
    "Choose cleanup preset": "Choose preset",
    "Collect minimum identifiers": "Vault ready",
    "Verify runtime trust": "Runtime checked",
    "Discover exposure candidates": "Scouting",
    "Confirm matches": "Match review",
    "Verify removal path": "Path verified",
    "Draft actions": "Draft ready",
    "Approval required": "Approval required",
    "Execute approved action": "Action ready",
    "Await confirmation": "Waiting",
    "Schedule recheck": "Recheck scheduled",
    "Escalate if needed": "Escalation ready",
    "Cleanup cycle complete": "Cycle complete",
    "Prepare wallet permissions": "Wallet ready",
    "Prepare one-off cleanup payment": "One-off payment ready",
    "Prepare monitoring subscription": "Monitor ready",
    "Ask Venice for redacted analysis": "Analysis ready",
    "Delegate specialist agents": "Agent network ready",
    "Relay latest payment": "Relay confirmed",
    "Prepare cleanup approval": "Approval drafted",
    "Waiting for approval": "Approval required",
    "Record approved action": isLiveExecutorMode() ? "Action executed" : "Action recorded",
    "Full demo complete": "Demo complete"
  }[title] || title;
}

function agentPromptForState() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  const readyActions = state.currentStatus?.actionsReady || [];
  const pendingFindings = state.currentStatus?.pendingFindings?.length ?? 0;
  const next = state.agentNext;
  const plan = state.agentPlan;
  if (!currentCase()) {
    if (state.onboardingPreviewBusy) {
      return { state: "Preview", message: "Scanning people-search brokers…", actions: [] };
    }
    if (isOnboardingWithoutCase() && !state.onboardingPreviewReady) {
      return { state: "Preview", message: "Checking listings before cleanup.", actions: [] };
    }
    if (state.onboardingPreviewReady) {
      return { state: "Start", message: "Finish the form and buy credits to start cleanup.", actions: [] };
    }
    return { state: "Start", message: "Enter your name → Start cleanup.", actions: [] };
  }
  if (!state.walletAddress && state.showAdvancedUI) {
    return { state: "Wallet", message: "Optional: connect wallet at the bottom of the sidebar.", actions: [] };
  }
  if (!plan) {
    return { state: "Setup", message: "Tap Next to run your template.", actions: ["run"] };
  }
  if (approvals.length > 0) {
    return {
      state: "Approve",
      message: "Review the card — nothing sends until you approve.",
      actions: ["review"]
    };
  }
  if (pendingFindings > 0) {
    return { state: "Review", message: "Tap Yes or Not me on each link.", actions: ["run"] };
  }
  if (next?.blockedReasons?.length) {
    const needsUrls = next.blockedReasons.includes("discovery-needed");
    return {
      state: "Paused",
      message: needsUrls ? "Add profile links, then Next." : next.message || "Paused — tap Next when ready.",
      actions: needsUrls ? ["run"] : ["run"]
    };
  }
  if (readyActions.length > 0) {
    return {
      state: executeActionLabel(),
      message: isLiveExecutorMode()
        ? "Tap Next to execute the approved connector path."
        : "Tap Next to record approved work.",
      actions: ["run"]
    };
  }
  if (plan.currentStep === "complete") {
    return { state: "Done", message: "Cleanup cycle complete.", actions: [] };
  }
  const stepMessages = {
    "collect-minimum-identifiers": "Vault ready.",
    "verify-trust": runtimeLabel().text,
    "discover-candidates": "Searching listings…",
    "confirm-matches": "Confirm your links.",
    "verify-removal-path": "Checking opt-out paths.",
    "draft-actions": "Drafting requests.",
    "request-approval": "Approval needed next.",
    "execute-approved-action": isLiveExecutorMode() ? "Ready to execute." : "Ready to record.",
    "await-confirmation": "Waiting on response.",
    "schedule-recheck": "Scheduling recheck.",
    "escalate-if-needed": "Preparing follow-up."
  };
  return {
    state: "Running",
    message: stepMessages[plan.currentStep] || "Tap Next to continue.",
    actions: ["run"]
  };
}

function hackathonPendingTracks() {
  const status = state.hackathonStatus;
  if (!status) return [];
  const pending = [];
  if (!status.x402OneOffReady) pending.push("x402");
  if (!status.erc7710SubscriptionReady) pending.push("ERC-7710");
  if (!status.veniceOutputReady) pending.push("Venice");
  if (!status.a2aRedelegationVisible) pending.push("A2A");
  if (!status.oneShotRelayerVisible) pending.push("1Shot");
  return pending;
}

function renderHackathonChecklist() {
  const target = $("#hackathon-checklist");
  if (!target) return;
  const pending = hackathonPendingTracks();
  const status = state.hackathonStatus;
  const rows = [
    ["MetaMask", status?.smartAccountVisible],
    ["ERC-7715 permission", status?.erc7715PermissionGranted],
    ["x402", status?.x402OneOffReady],
    ["ERC-7710", status?.erc7710SubscriptionReady],
    ["Venice", status?.veniceOutputReady],
    ["A2A", status?.a2aRedelegationVisible],
    ["1Shot", status?.oneShotRelayerVisible]
  ];
  const actionNote = pending.length
    ? `<p class="muted small warn">Pending: ${pending.join(", ")}. Use Payment rails, Venice classify, Delegate sub-agents, and Relay paid session below — each runs a live integration.</p>`
    : '<p class="muted small">All sponsor tracks ready.</p>';
  const oneShotNote =
    status?.oneShotRelayerVisible
      ? ""
      : state.integrationsStatus?.liveReady?.oneShot
        ? '<p class="muted small warn">1Shot stays pending until you relay a paid session (Relay paid session below).</p>'
        : "";
  target.innerHTML =
    rows
      .map(([label, value]) => {
        const hint =
          label === "1Shot" && value
            ? " (live relay)"
            : label === "x402" && value && !(state.hackathon?.payments || []).some((session) => session.status === "paid")
              ? " (session only)"
              : "";
        return `
    <div class="status-row">
      <span>${label}</span>
      <strong class="${pillClass(value)}">${value ? `ready${hint}` : "pending"}</strong>
    </div>
  `;
      })
      .join("") + actionNote + oneShotNote;
}

function renderAgentPresetStarters() {
  const panel = $("#agent-template-panel");
  const container = $("#agent-preset-starters");
  if (!panel || !container) return;
  const show = state.appOpen && !(isOnboardingWithoutCase() && !state.onboardingPreviewReady);
  panel.hidden = !show;
  if (!show) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = Object.entries(AGENT_INTAKE_TEMPLATES)
    .map(([presetId, template]) => {
      const title = presentPreset({ id: presetId }).title;
      const active = presetId === state.selectedPresetId;
      return `<button type="button" class="agent-preset-starter${active ? " active" : ""}" data-agent-preset="${presetId}" data-testid="agent-preset-${presetId}">${escapeHtml(title)}</button>`;
    })
    .join("");
}

function renderAgentChat() {
  const next = state.agentNext;
  const prompt = agentPromptForState();
  $("#agent-dock")?.classList.toggle("open", state.dockOpen);
  $("#app-agent-column")?.classList.toggle("open", state.dockOpen);
  const brief = $("#agent-dock-brief");
  if (brief) {
    brief.textContent = isOnboardingWithoutCase() && !state.onboardingPreviewReady
      ? state.onboardingPreviewBusy
        ? "Searching people-search brokers for your name…"
        : "Enter your name and city, then check listings."
      : state.appOpen && !currentCase()
        ? "Pick a template below — it fills the chat and the main form."
        : prompt.message;
  }
  const live = $("#agent-live");
  if (live) live.textContent = `${prompt.state}. ${prompt.message}`;

  renderAgentPresetStarters();

  const log = $("#agent-chat-messages");
  const logShell = $("#agent-chat-log");
  if (log) {
    const transcript = onboardingChatTranscript();
    if (state.appOpen && !currentCase() && state.onboardingPreviewReady && transcript.length <= 2) {
      transcript.push({
        role: "agent",
        text: "Tap a template chip above to load a starter request, or type your own message below."
      });
    } else if (currentCase() && next) {
      transcript.push({
        role: "agent",
        text: `${shortStepTitle(next.title)} · ${next.message || "standing by"}`
      });
    }
    log.innerHTML = transcript.slice(-40).map(renderChatBubble).join("");
    bindIcons(log);
    runChatTypewriters(log, logShell);
    if (logShell) logShell.scrollTop = logShell.scrollHeight;
  }

  renderAgentQuickActions(prompt.actions);
  renderAgentActionCards();
  renderAgentSuggestionStrip(prompt);
  renderAgentSuggestions(prompt);
}

function renderAgentSuggestionStrip(prompt) {
  const container = $("#agent-suggestion-strip");
  if (!container) return;
  container.innerHTML = "";

  const phrases = [];
  if (state.appOpen) {
    phrases.push(guidePrimaryLabel(currentGuideStep()));
    phrases.push("Verify TEE");
  }
  if (prompt.actions.includes("review")) phrases.push("Review approval");
  if (prompt.actions.includes("explain")) phrases.push("Explain disclosure");
  if (currentCase()) {
    phrases.push("What's next?");
  }
  if (!currentCase() && state.appOpen) {
    phrases.push("Help me start");
  }

  [...new Set(phrases)].slice(0, 5).forEach((phrase) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "agent-suggestion-chip";
    btn.textContent = phrase;
    btn.addEventListener("click", () => fillAgentInput(phrase));
    container.appendChild(btn);
  });

  const agentDoNext = $("#agent-do-next");
  if (agentDoNext) setButtonLabel(agentDoNext, phrases[0] || "Next");
}

function renderAgentQuickActions(actions) {
  const actionSet = new Set(actions);
  const buttonMap = {
    start: $("#agent-start-recommended"),
    run: $("#agent-run-next"),
    review: $("#agent-review-approval"),
    explain: $("#agent-explain-disclosure"),
    settings: null,
    wallet: null
  };
  Object.entries(buttonMap).forEach(([key, button]) => {
    if (button) button.hidden = !actionSet.has(key);
  });
}

function renderAgentSuggestions(prompt) {
  const container = $("#agent-suggestions");
  if (!container) return;
  container.innerHTML = "";

  const suggestions = [];
  if (prompt.actions.includes("start")) suggestions.push("start recommended");
  if (prompt.actions.includes("run")) suggestions.push("run next");
  if (prompt.actions.includes("review")) suggestions.push("review approval");
  if (prompt.actions.includes("explain")) suggestions.push("explain disclosure");
  if (suggestions.length === 0 && currentCase()) {
    suggestions.push("run", "status");
  }

  suggestions.slice(0, 4).forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => fillAgentInput(label));
    container.appendChild(btn);
  });
}

function renderAgentActionCards() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  const readyActions = state.currentStatus?.actionsReady || [];
  const cards = [
    ...approvals.map((approval) => `
      <div class="row" data-testid="approval-card">
        <div>
          <strong>Approval needed: ${escapeHtml(approval.destination)}</strong>
          <div class="muted small">${approval.actionType} · disclose ${approval.dataToDisclose.join(", ")} · expires ${escapeHtml(approval.expiresAt.slice(0, 10))}</div>
        </div>
        <button data-chat-approve-id="${approval.id}" data-testid="approve-exact">Approve exact action</button>
      </div>
    `),
    ...readyActions.map((action) => `
      <div class="row" data-testid="ready-action-card">
        <div>
          <strong>Ready: ${escapeHtml(action.destination)}</strong>
          <div class="muted small">${action.actionType} · ${action.executionStatus}</div>
        </div>
        <button data-chat-execute-id="${action.id}" data-testid="record-action">${executeActionLabel()} action</button>
      </div>
    `)
  ];
  const container = $("#agent-action-cards");
  if (!container) return;
  container.innerHTML = cards.join("");
}

function hasActiveCase() {
  return Boolean(state.currentCaseId && currentCase() && state.currentStatus);
}

function shortenAddress(address) {
  if (!address || address.length < 12) return address || "Not connected";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function pickMetaMaskFromWindow() {
  const eth = window.ethereum;
  if (!eth) return null;
  const list = eth.providers?.length ? eth.providers : eth.isMetaMask !== undefined ? [eth] : [];
  if (list.length) {
    const mm = list.find((p) => p.isMetaMask);
    if (mm) return mm;
    walletLog.warn("No isMetaMask flag; multiple wallets may conflict", {
      count: list.length,
      names: list.map((p) => p.isMetaMask ? "metamask" : "other")
    });
  }
  if (eth.isMetaMask) return eth;
  return null;
}

async function resolveEthereumProvider(options = {}) {
  if (!options.forceFresh && state.ethereumProvider?.request) {
    walletLog.info("Reusing cached provider", { isMetaMask: state.ethereumProvider.isMetaMask });
    return state.ethereumProvider;
  }
  const direct = pickMetaMaskFromWindow();
  if (direct?.request) {
    walletLog.info("Using window MetaMask provider", { isMetaMask: direct.isMetaMask });
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
      walletLog.info("EIP-6963 discovery", {
        total: providers.length,
        picked: preferred?.info?.name || providers[0]?.info?.name || "none"
      });
      resolve(preferred?.provider || providers[0]?.provider || null);
    }, 800);
  });
  if (discovered?.request) return discovered;
  walletLog.warn("No injected provider — demo wallet fallback");
  return null;
}

async function revokeWalletPermissions(provider) {
  if (!provider?.request) return;
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }]
    });
    walletLog.info("wallet_revokePermissions ok");
  } catch (error) {
    walletLog.warn("wallet_revokePermissions skipped", { code: error?.code, message: error?.message });
  }
}

async function requestWalletAccounts(provider, options = {}) {
  if (!provider?.request) return [];
  if (options.pickAccount) {
    try {
      await provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch (error) {
      if (error?.code === 4001) throw error;
      walletLog.warn("wallet_requestPermissions skipped", { code: error?.code, message: error?.message });
    }
  }
  return provider.request({ method: "eth_requestAccounts" });
}

function walletButtonLabel() {
  if (state.smartAccountAddress) return shortenAddress(state.smartAccountAddress);
  if (state.walletAddress) return shortenAddress(state.walletAddress);
  return "Connect wallet";
}

function walletButtonTitle() {
  if (state.walletConnectError) return state.walletConnectError;
  if (state.smartAccountAddress) return `Smart Account · ${state.smartAccountAddress} · click for wallet details`;
  if (state.walletAddress) return `${state.walletAddress} · click for wallet details`;
  return "Connect MetaMask";
}

function toggleWalletModal(open) {
  const dialog = $("#wallet-modal");
  if (!dialog) return;
  const shouldOpen = typeof open === "boolean" ? open : !dialog.open;
  if (shouldOpen) {
    renderWalletModal();
    if (!dialog.open) dialog.showModal();
    state.walletModalOpen = true;
    bindIcons(dialog);
    return;
  }
  if (dialog.open) dialog.close();
  state.walletModalOpen = false;
}

function renderWalletModal() {
  const body = $("#wallet-modal-body");
  if (!body) return;
  const wallet = state.walletAddress || "Not connected";
  const smart = state.smartAccountAddress || "Not created";
  const mode = state.walletMode || "—";
  const liveHint = state.walletConfig?.liveEnabled
    ? "Sepolia Smart Account upgrade uses MetaMask wallet_sendCalls (EIP-5792)."
    : "Smart Account records EIP-7702 + ERC-7715 permissions. Enable WALLET_LIVE_MODE for Sepolia on-chain upgrade.";
  body.innerHTML = `
    ${state.walletAddress ? `
    <div class="status-list wallet-modal-status">
      <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
      <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
      <div class="status-row"><span>Mode</span><strong>${escapeHtml(mode)}</strong></div>
    </div>` : `<p class="muted small">Connect MetaMask to pay with USDC on Base and enable Smart Account features.</p>`}
    ${state.walletConnectNote ? `<p class="muted small">${escapeHtml(state.walletConnectNote)}</p>` : ""}
    ${walletErrorMarkup(state.walletConnectError)}
    <p class="muted small wallet-modal-hint">${escapeHtml(liveHint)}</p>
    <details class="wallet-debug-panel advanced-only">
      <summary>Wallet log</summary>
      <pre id="wallet-debug-log" class="wallet-debug-log"></pre>
    </details>
  `;
  renderWalletDebugLog();
  const connectBtn = $("#wallet-modal-connect");
  const disconnectBtn = $("#wallet-modal-disconnect");
  const liveBtn = $("#wallet-modal-live-upgrade");
  const smartBtn = $("#wallet-modal-smart-account");
  if (connectBtn) connectBtn.hidden = Boolean(state.walletAddress);
  if (disconnectBtn) disconnectBtn.hidden = !state.walletAddress;
  if (liveBtn) {
    liveBtn.hidden = !state.walletConfig?.liveEnabled || !state.walletAddress;
  }
  if (smartBtn) {
    smartBtn.hidden = !state.currentCaseId || !state.walletAddress || Boolean(state.smartAccountAddress);
  }
}

function renderWalletFeedback() {
  const errorText = state.walletConnectError || "";
  const primary = $("#wallet-feedback-primary");
  if (primary) {
    setInlineStatus(primary, errorText, {
      baseClass: "visually-hidden wallet-connect-feedback",
      variant: isUserRejectedError(errorText) ? "warning" : errorText ? "fail" : undefined
    });
  }
  document.querySelectorAll("[data-wallet-feedback-secondary]").forEach((node) => {
    if (errorText) {
      node.hidden = false;
      setInlineStatus(node, errorText, {
        baseClass: "wallet-connect-feedback",
        variant: isUserRejectedError(errorText) ? "warning" : "fail"
      });
    } else {
      node.hidden = true;
      setInlineStatus(node, "");
    }
  });
}

function openPaymentRails() {
  state.tab = "settings";
  state.dockOpen = false;
  render();
  window.setTimeout(() => {
    $("#payment-rails")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 80);
}

function openWalletHub() {
  toggleWalletModal(true);
}

function renderWalletCommandStrip() {
  const strip = $("#wallet-command-strip");
  if (!strip) return;
  strip.hidden = !state.appOpen;
  const primary = $("#connect-wallet-primary");
  if (primary) {
    setButtonLabel(primary, walletButtonLabel());
    primary.title = walletButtonTitle();
    primary.classList.toggle("connected", Boolean(state.walletAddress));
    primary.disabled = false;
    primary.removeAttribute("data-connect-wallet");
    primary.removeAttribute("data-wallet-modal");
    if (!state.walletAddress) primary.setAttribute("data-connect-wallet", "");
    else primary.setAttribute("data-wallet-modal", "");
  }
  if (state.walletModalOpen) renderWalletModal();
}

function renderWalletPanels() {
  const wallet = state.walletAddress || "Not connected";
  const smart = state.smartAccountAddress || "Not created";
  const rows = `
    <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
    <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
  `;
  const onboardingWallet = $("#onboarding-wallet-status");
  if (onboardingWallet) onboardingWallet.innerHTML = rows;
  renderWalletFeedback();
  renderWalletCommandStrip();
}

function formatProductPrice(product) {
  if (product.mode === "subscription") {
    return `$${product.amountUsd} ${product.token}/mo`;
  }
  return `$${product.amountUsd} ${product.token}`;
}

function paymentPlanLabel(mode) {
  return mode === "subscription" ? "Monitor subscription ($10 USDC/mo)" : "Starter credits ($5 USDC)";
}

function hasEntitledPayment(mode) {
  const sessions = state.hackathon?.payments || [];
  return sessions.some((session) => session.mode === mode && session.status === "paid");
}

function hasSubscriptionEntitlement() {
  return hasEntitledPayment("subscription") || state.aiEntitlement?.mode === "subscription";
}

function caseIsActivated() {
  if (state.currentStatus?.activated) return true;
  return hasEntitledPayment(state.selectedPaymentMode || "one-off");
}

function assertCaseActivatedClient(options = {}) {
  if (caseIsActivated()) return;
  if (!options.quiet) {
    addChat("agent", "Connect your wallet and buy credits for this case before continuing.");
    openPaymentRails();
  }
  throw {
    error: "case-activation-required",
    message: "Buy credits for this case to continue cleanup."
  };
}

function upsellDismissKey(caseId) {
  return `oblivion.upsellDismissed.${caseId}`;
}

function isUpsellDismissed(caseId) {
  if (!caseId) return true;
  return localStorage.getItem(upsellDismissKey(caseId)) === "1";
}

function dismissSubscriptionUpsell() {
  if (!state.currentCaseId) return;
  localStorage.setItem(upsellDismissKey(state.currentCaseId), "1");
  renderSubscriptionUpsell();
}

function selectPaymentMode(mode) {
  if (mode !== "one-off" && mode !== "subscription") return;
  state.selectedPaymentMode = mode;
  localStorage.setItem("oblivion.paymentMode", mode);
  document.querySelectorAll(".payment-plan-card").forEach((card) => {
    const active = card.dataset.paymentPlan === mode;
    card.classList.toggle("active", active);
    const input = card.querySelector('input[type="radio"]');
    if (input) input.checked = active;
  });
}

function syncPaymentPlanFromForm() {
  const selected = document.querySelector('input[name="payment-plan"]:checked');
  if (selected?.value) selectPaymentMode(selected.value);
}

function renderOnboardingSteps() {
  const hasCase = Boolean(state.currentCaseId && currentCase());
  const onboarding = state.appOpen && !hasCase;
  const previewStep = onboarding && !state.onboardingPreviewReady;
  const fullStep = onboarding && state.onboardingPreviewReady;
  $("#onboarding-preview-fields")?.toggleAttribute("hidden", !onboarding);
  $("#onboarding-intake-full")?.toggleAttribute("hidden", !fullStep);
  $("#onboarding-check-listings")?.toggleAttribute("hidden", !previewStep || state.onboardingPreviewBusy);
  $("#start-cleanup")?.toggleAttribute("hidden", !fullStep);
  $("#simple-preset-row")?.toggleAttribute("hidden", true);
  $("#onboarding-route-note")?.toggleAttribute("hidden", !fullStep);
  if (onboarding) selectPresetId(onboardingPresetId());
}

function renderOnboardingPayment() {
  const panel = $("#onboarding-payment");
  if (!panel) return;
  const hasCase = Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  const showPayment = hasCase
    ? state.appOpen && (!caseIsActivated() || state.preSearchReady)
    : state.appOpen && state.onboardingPreviewReady;
  panel.hidden = !showPayment;
  selectPaymentMode(state.selectedPaymentMode);
  const oneOff = state.products.find((item) => item.id === "credit-starter");
  const subscription = state.products.find((item) => item.id === "credit-monitor");
  const oneOffCard = document.querySelector('.payment-plan-card[data-payment-plan="one-off"]');
  const subCard = document.querySelector('.payment-plan-card[data-payment-plan="subscription"]');
  if (oneOff && oneOffCard) {
    const price = oneOffCard.querySelector(".payment-plan-price");
    const detail = oneOffCard.querySelector(".payment-plan-detail");
    if (price) price.textContent = formatProductPrice(oneOff);
    if (detail) {
      const credits = state.creditRates?.starterPackCredits || 500;
      detail.textContent = oneOff.description || `$5 USDC · ${credits} wallet credits`;
    }
  }
  if (subscription && subCard) {
    const price = subCard.querySelector(".payment-plan-price");
    const detail = subCard.querySelector(".payment-plan-detail");
    if (price) price.textContent = formatProductPrice(subscription);
    if (detail) {
      const credits = state.creditRates?.monitorMonthlyCredits || 1200;
      detail.textContent = subscription.description || `$10 USDC/mo · ${credits} credits refilled monthly`;
    }
  }
}

function renderSubscriptionUpsell() {
  const banner = $("#subscription-upsell");
  if (!banner) return;
  const show =
    Boolean(state.currentCaseId && state.currentStatus) &&
    (state.aiEntitlement?.mode === "one-off" || hasEntitledPayment("one-off")) &&
    !hasSubscriptionEntitlement() &&
    !isUpsellDismissed(state.currentCaseId);
  banner.hidden = !show;
}

async function ensureCasePayment(options = {}) {
  const mode = state.selectedPaymentMode || "one-off";
  const statusEl = options.statusEl || $("#onboarding-payment-status");
  if (!state.walletAddress) {
    if (statusEl) {
      setInlineStatus(statusEl, "Connect MetaMask to pay for this cleanup…", {
        baseClass: "muted small onboarding-payment-status"
      });
    }
    if (!options.quiet) {
      addChat("agent", "Approve the MetaMask connection to pay for this cleanup.");
    }
    await connectWallet({ openHub: false });
  }
  await refreshHackathon({ silent: true }).catch(() => {});
  if (hasEntitledPayment(mode)) {
    if (statusEl) {
      setInlineStatus(statusEl, `${paymentPlanLabel(mode)} is active for this case.`, {
        baseClass: "muted small onboarding-payment-status",
        variant: "success"
      });
    }
    return { ok: true, mode, alreadyPaid: true };
  }
  const liveX402 = isLiveX402Ready(state.integrationsStatus);
  if (statusEl) {
    setInlineStatus(
      statusEl,
      liveX402
        ? `Confirm ${paymentPlanLabel(mode)} USDC on Base Sepolia in MetaMask…`
        : `Confirm ${paymentPlanLabel(mode)} in MetaMask…`,
      { baseClass: "muted small onboarding-payment-status" }
    );
  }
  if (!state.smartAccountAddress) {
    await enableSmartAccount({ quiet: true, openHub: false }).catch(() =>
      createSmartAccount({ quiet: true, openHub: false })
    );
  }
  await preparePayment(mode, { quiet: true, skipSettle: false, statusEl });
  await refreshHackathon({ silent: true }).catch(() => {});
  if (statusEl) {
    setInlineStatus(
      statusEl,
      hasEntitledPayment(mode)
        ? `${paymentPlanLabel(mode)} confirmed — agent AI unlocked for this case.`
        : liveX402
          ? "Payment not confirmed. Open Settings → Payment rails and tap Pay once / Subscribe."
          : "Payment session prepared. Open Settings → Payment rails if MetaMask did not confirm.",
      {
        baseClass: "muted small onboarding-payment-status",
        variant: hasEntitledPayment(mode) ? "success" : undefined
      }
    );
  }
  if (!options.quiet) {
    addChat(
      "agent",
      hasEntitledPayment(mode)
        ? `${paymentPlanLabel(mode)} is set for this case. I'll still pause for your approval before anything sends.`
        : liveX402
          ? "Confirm USDC payment in MetaMask on Base Sepolia, or finish in Settings → Payment rails."
          : "Finish payment in Settings → Payment rails if MetaMask did not confirm."
    );
  }
  renderSubscriptionUpsell();
  const paid = hasEntitledPayment(mode);
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

function productBudgetLine(product) {
  if (product.id === "credit-starter") {
    const credits = state.creditRates?.starterPackCredits || 500;
    return `${credits} credits · ~50k Venice tokens · 25 credits/email relay`;
  }
  if (product.id === "credit-monitor") {
    const credits = state.creditRates?.monitorMonthlyCredits || 1200;
    return `${credits} credits/month refill · metered AI + operator email`;
  }
  return product.description || "";
}

function renderPayments() {
  renderWalletPanels();
  const grid = $("#payment-rails-grid");
  const lead = document.querySelector(".payment-rails-lead");
  if (lead) {
    lead.textContent =
      "Pay with USDC on Base Sepolia via x402. Smart account upgrade uses Ethereum Sepolia — MetaMask will ask you to switch networks.";
  }
  if (grid) {
    const x402Notice = !isLiveX402Ready(state.integrationsStatus)
      ? `<p class="muted small warn payment-rails-notice">x402 is not configured on the API server (set X402_PAY_TO and redeploy). Payment settlement is skipped until then.</p>`
      : state.paymentRailsNotice
        ? `<p class="muted small warn payment-rails-notice">${escapeHtml(state.paymentRailsNotice)}</p>`
        : "";
    grid.innerHTML = state.products.length
      ? state.products.map((product) => {
          const activeSession = (state.hackathon?.payments || []).find(
            (session) => session.productId === product.id
          );
          const status = activeSession?.status || "not-started";
          const statusLabel =
            status === "paid"
              ? "paid"
              : status === "payment-required" && isLiveX402Ready(state.integrationsStatus)
                ? "payment-required — confirm USDC on Base Sepolia in MetaMask"
                : status === "payment-required"
                  ? "payment-required — x402 not configured on server"
                  : status;
          return `
            <article class="payment-rail-card" data-payment-product="${product.id}">
              <div class="payment-rail-head">
                <strong>${escapeHtml(product.name)}</strong>
                <span class="pill">${formatProductPrice(product)}</span>
              </div>
              <p class="muted small">${escapeHtml(product.description)}</p>
              <p class="muted small payment-rail-budget">${escapeHtml(productBudgetLine(product))}</p>
              <button
                type="button"
                class="${product.mode === "subscription" ? "secondary" : ""}"
                data-pay-product="${product.id}"
                data-pay-mode="${product.mode}"
                data-testid="pay-${product.id}"
              >
                ${product.mode === "subscription" ? "Subscribe" : "Pay once"}
              </button>
              <p class="muted small payment-rail-status">${escapeHtml(statusLabel)}</p>
            </article>
          `;
        }).join("")
      : `<div class="empty">Payment products are loading.</div>`;
    grid.innerHTML = x402Notice + grid.innerHTML;
  }
  const entitlementEl = $("#ai-entitlement-status");
  if (entitlementEl) {
    const ent = state.aiEntitlement;
    if (!state.walletAddress) {
      entitlementEl.innerHTML = `<div class="status-row"><span>Credits</span><strong>Connect wallet</strong></div>`;
    } else {
      const balance = state.creditsBalance?.balanceCredits ?? ent?.balanceCredits ?? 0;
      const subscription = state.creditsBalance?.subscriptionActive ? "active" : "none";
      entitlementEl.innerHTML = `
        <div class="status-row"><span>Credit balance</span><strong>${balance}</strong></div>
        <div class="status-row"><span>Subscription</span><strong>${escapeHtml(subscription)}</strong></div>
        <div class="status-row"><span>Email relay</span><strong>${state.creditRates?.emailRelayCredits || 25} credits/send</strong></div>
      `;
    }
  }
  const payments = state.hackathon?.payments || [];
  $("#payments-table").innerHTML = payments.length
    ? payments.map((session) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(session.productId)}</strong>
            <div class="muted small">${session.mode} · ${session.amountUsd} ${session.token} · ${session.status}</div>
          </div>
          <span class="${pillClass(session.status === "paid")}">x402</span>
        </div>
      `).join("")
    : `<div class="empty">No payment session yet. Choose a plan above.</div>`;
}

function renderAgentNetwork() {
  const timeline = state.hackathon?.timeline || [];
  const delegations = state.hackathon?.delegations || [];
  const venice = state.hackathon?.veniceAnalyses || [];
  const items = [
    ...venice.map((analysis) => ({
      actor: "Venice",
      title: analysis.output.title,
      summary: analysis.output.summary
    })),
    ...delegations.map((delegation) => ({
      actor: delegation.toAgent,
      title: `Delegated ${delegation.toAgent}`,
      summary: delegation.scope.join(", ")
    })),
    ...timeline.map((event) => ({
      actor: event.actor,
      title: event.title,
      summary: event.summary
    }))
  ];
  $("#agent-timeline").innerHTML = items.length
    ? items.slice(-12).reverse().map((item) => `
        <div class="timeline-item">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="muted small">${escapeHtml(item.actor)} · ${escapeHtml(item.summary)}</div>
        </div>
      `).join("")
    : `<div class="empty">No agent events yet. Run Venice or delegate sub-agents.</div>`;
}

function renderRelayer() {
  const events = state.hackathon?.relayerEvents || [];
  $("#relayer-table").innerHTML = events.length
    ? events.map((event) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(event.status)}</strong>
            <div class="muted small">${escapeHtml(event.txHash || "pending tx")} · ${escapeHtml(event.message)}</div>
          </div>
          <span class="${pillClass(event.status === "confirmed" && !event.payload?.checklistOnly ? "pass" : "warn")}">${event.payload?.checklistOnly ? "checklist" : "1Shot"}</span>
        </div>
      `).join("")
    : `<div class="empty">No relayer events yet. Relay a prepared payment session.</div>`;
}

function renderApprovals() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  $("#approval-table").innerHTML = approvals.length
    ? approvals.map((approval) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(approval.destination)}</strong>
            <div class="muted small">${approval.actionType} · disclose ${approval.dataToDisclose.join(", ")}</div>
          </div>
          <button class="secondary" data-approve-id="${approval.id}">Approve</button>
        </div>
      `).join("")
    : `<div class="empty">No approval waiting. Choose one agent task first.</div>`;
}

function renderActions() {
  const actions = [
    ...(state.currentStatus?.actionsReady || []),
    ...(state.currentStatus?.submittedActions || [])
  ];
  $("#action-table").innerHTML = actions.length
    ? actions.map((action) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(action.destination)}</strong>
            <div class="muted small">${action.actionType} · ${action.executionStatus}</div>
          </div>
          ${action.executionStatus === "ready" ? `<button data-execute-id="${action.id}">${executeActionLabel()}</button>` : `<span class="${pillClass(action.executionStatus)}">${escapeHtml(action.executionStatus)}</span>`}
        </div>
      `).join("")
    : `<div class="empty">No actions yet. Approved tasks will appear here.</div>`;
}

function renderTabs() {
  syncRouteTabVisibility();
  document.querySelectorAll(".tab").forEach((button) => {
    if (button.hidden) return;
    const active = button.dataset.tab === state.tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${state.tab}`);
  });
}

function renderVaultPanel() {
  const status = $("#vault-status");
  const exportBtn = $("#export");
  const passphraseInput = $("#export-passphrase");
  const hasCase = Boolean(state.currentCaseId);
  const hasVaultKey = Boolean(state.vaultKey);
  if (status) {
    if (!hasCase) {
      status.textContent = "Select or create a case to export its encrypted backup.";
      status.className = "vault-status muted small";
    } else if (!hasVaultKey || state.sessionHandoffWarning) {
      status.textContent = [
        !hasVaultKey
          ? "Vault key is only in memory for cases opened this session. You can still download redacted server data; add a passphrase only if the key is available."
          : "",
        state.sessionHandoffWarning
      ]
        .filter(Boolean)
        .join(" ");
      status.className = "vault-status muted small warn";
    } else {
      status.textContent = `Ready to export ${caseDeleteLabel(state.currentCaseId)}. Add a passphrase to wrap your vault key in the backup.`;
      status.className = "vault-status muted small pass";
    }
  }
  if (exportBtn) exportBtn.disabled = !hasCase;
  if (passphraseInput) {
    passphraseInput.disabled = !hasCase;
    passphraseInput.placeholder = hasVaultKey
      ? "Only needed to wrap the vault key"
      : "Unavailable after refresh — export redacted data without a passphrase";
  }
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

function render() {
  renderTrust();
  renderCases();
  renderShell();
  renderUserGuide();
  renderWalletCommandStrip();
  renderIntakeInferencePreview();
  renderDashboard();
  renderOnboardingSteps();
  renderOnboardingPayment();
  renderSubscriptionUpsell();
  renderFindings();
  renderPresets();
  renderAgentChat();
  renderHackathonChecklist();
  renderPrivacyFilterSettings();
  renderAgentVoiceSettings();
  applyPrivacyFilterToInputs();
  renderPayments();
  renderAgentNetwork();
  renderRelayer();
  renderApprovals();
  renderActions();
  renderVaultPanel();
  renderTabs();
  updateAgentSendState();
  updateLandingSendState();
  bindIcons();
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

function updateLandingSendState() {
  const input = $("#landing-input");
  const send = $("#landing-send");
  if (!input || !send) return;
  const hasText = Boolean(input.value.trim());
  send.disabled = !hasText;
  send.classList.toggle("send-ready", hasText);
  send.setAttribute("aria-disabled", hasText ? "false" : "true");
}

function brokerPreviewResultMarkup(item) {
  const score = item.matchScore ? ` · ${item.matchScore}` : "";
  const broker = item.brokerLabel ? `${escapeHtml(item.brokerLabel)}` : shortenUrl(item.sourceUrl);
  const reason = item.matchReason
    ? `<span class="muted small pre-search-reason">${escapeHtml(item.matchReason)}</span>`
    : "";
  return `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${broker}</a>${score}${reason ? `<br />${reason}` : ""}`;
}

function previewStatsMessage(stats, candidateCount, region) {
  if (!stats) return "";
  const parts = [
    `Checked ${stats.brokersChecked ?? 0} brokers`,
    `${stats.sweepHits ?? 0} sweep hit(s)`,
    `${stats.broadSearchHits ?? 0} broad-search hit(s)`
  ];
  let message = parts.join(" · ");
  if (stats.searchErrors) message += ` · ${stats.searchErrors} search error(s)`;
  if (candidateCount < 5) {
    message += region
      ? ". Few strong matches — full cleanup searches more sources after you start a case."
      : ". Add city/state for better preview matches, or continue to full cleanup.";
  }
  return message;
}

function renderBrokerPreviewResults(candidates, message) {
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (!panel || !list || !preStatus) return;
  panel.hidden = false;
  preStatus.textContent = message;
  const rows = candidates || [];
  if (!rows.length) {
    list.innerHTML = `<li class="muted">No broker listings matched yet. Continue to start full cleanup with Venice-scored discovery.</li>`;
    return;
  }
  list.innerHTML = rows
    .map((item) => `<li class="pre-search-result-visible">${brokerPreviewResultMarkup(item)}</li>`)
    .join("");
}

async function streamBrokerPreviewResults(candidates, message) {
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (!panel || !list || !preStatus) return;
  panel.hidden = false;
  preStatus.textContent = message;
  list.innerHTML = "";
  const rows = candidates || [];
  if (!rows.length) {
    list.innerHTML = `<li class="muted">No broker listings matched yet. Continue to start full cleanup with Venice-scored discovery.</li>`;
    return;
  }
  for (const item of rows) {
    const row = document.createElement("li");
    row.className = "pre-search-result-enter";
    row.innerHTML = brokerPreviewResultMarkup(item);
    list.appendChild(row);
    void row.offsetWidth;
    row.classList.add("pre-search-result-visible");
    await previewDelay(70);
  }
}

async function runOnboardingPreview() {
  const name = $("#simple-name")?.value?.trim();
  const region = $("#simple-region")?.value?.trim();
  if (!name) {
    pulseFocusField($("#simple-name"));
    return;
  }
  const preStatus = $("#pre-search-status");
  const statusEl = $("#simple-start-status");
  const btn = $("#onboarding-check-listings");
  const landingSend = $("#landing-send");
  const list = $("#pre-search-results");
  state.onboardingPreviewBusy = true;
  if (preStatus) preStatus.textContent = "Checking people-search brokers…";
  if (list) list.innerHTML = "";
  $("#pre-search-panel")?.removeAttribute("hidden");
  if (btn) btn.disabled = true;
  if (landingSend) landingSend.disabled = true;
  if (statusEl) statusEl.textContent = "";
  renderOnboardingSteps();
  const regionNote = region ? ` in ${region}` : "";
  addChat("agent", `Checking people-search brokers for ${name}${regionNote}…`);
  renderAgentChat();
  try {
    const result = await request("/api/discovery/preview", {
      method: "POST",
      body: {
        personLabel: name,
        regionLabel: region || undefined,
        walletAddress: state.walletAddress || undefined
      }
    });
    addChat("agent", "Scanning broker indexes and ranking likely matches…");
    renderAgentChat();
    await previewDelay(280);
    const quotaNote =
      result.dailyLimit > 0
        ? ` ${result.remainingPreviews ?? 0} free preview(s) left today.`
        : "";
    const candidates = (result.candidates || []).filter((item) => item.matchScore !== "unlikely");
    const statsNote = previewStatsMessage(result.stats, candidates.length, region);
    const message = candidates.length
      ? `Preview found ${candidates.length} possible listing(s).${quotaNote}${statsNote ? ` ${statsNote}` : ""}`
      : `No broker hits in preview.${quotaNote || " Continue to start full cleanup."}${statsNote ? ` ${statsNote}` : ""}`;
    if (candidates.length) {
      addChat("agent", `Found ${candidates.length} possible listing(s). Streaming matches below…`);
      if (statsNote) addChat("agent", statsNote);
      renderAgentChat();
      await streamBrokerPreviewResults(candidates, message);
    } else {
      renderBrokerPreviewResults(candidates, message);
      addChat("agent", statsNote || "No broker hits in this preview. You can still start full cleanup below.");
      renderAgentChat();
    }
    state.onboardingPreviewReady = true;
    addChat("agent", "Listings preview complete. Finish the form below and buy credits to start cleanup.");
    render();
    $("#onboarding-intake-full")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    if (preStatus) {
      preStatus.textContent = error?.message || "Preview unavailable. Try again.";
    }
    addChat("agent", error?.message || "Preview unavailable. Try again.");
    renderAgentChat();
    write(error);
  } finally {
    state.onboardingPreviewBusy = false;
    if (btn) btn.disabled = false;
    updateLandingSendState();
    renderOnboardingSteps();
  }
}

const request = apiRequest;

async function createCase(options = {}) {
  state.appOpen = true;
  state.dockOpen = true;
  location.hash = "app";
  if (!state.walletAddress) {
    await connectWallet({ openHub: false });
  }
  if (!state.walletAddress) {
    throw { error: "wallet-required", message: "Connect MetaMask to start cleanup." };
  }
  const parsed = options.parsed
    ? { ...options.parsed }
    : parseIntakeForCase(options.intakeText ?? $("#agent-intake")?.value ?? $("#intake")?.value ?? "");
  if (!parsed.intakeText) {
    throw { error: "intake-required", message: "Enter your name to continue." };
  }
  applyParsedIntakeToForm(parsed);

  state.operatorEmailRelay = $("#operator-email-relay")?.checked !== false;
  state.contactEmail = $("#contact-email")?.value?.trim() || "";
  const created = await request("/api/cases", {
    method: "POST",
    body: {
      jurisdiction: parsed.jurisdiction,
      authorityBasis: parsed.authorityBasis,
      riskLevel: parsed.riskLevel,
      casePreferences: { operatorEmailRelay: state.operatorEmailRelay }
    }
  });
  const caseId = created.case.id;
  if (created.accessToken) setCaseToken(caseId, created.accessToken);
  const intakeText = parsed.intakeText;
  if (!state.vaultKey) state.vaultKey = await Vault.createVaultKey();
  const encryptedIntake = await Vault.encryptPayload(
    state.vaultKey,
    { notes: intakeText, contactEmail: state.contactEmail || undefined },
    caseId
  );
  const label = parsed.personLabel;
  const intake = await request(`/api/cases/${caseId}/intake`, {
    method: "POST",
    body: {
      encryptedIntake,
      redactedScope: redactedScopeFromIntake(parsed)
    }
  });
  state.currentCaseId = caseId;
  state.currentStatus = intake.status;
  state.cases.unshift({ ...intake.case, status: intake.status });
  syncPaymentPlanFromForm();
  try {
    await ensureCasePayment({ quiet: false, statusEl: $("#onboarding-payment-status") });
  } catch (error) {
    await syncCurrentCaseStatus();
    if (!caseIsActivated()) throw error;
  }
  if (!caseIsActivated()) {
    throw {
      error: "case-activation-required",
      message: "Buy credits for this case to continue cleanup."
    };
  }
  state.agentPlan = null;
  state.connectorResults = [];
  state.intakeText = intakeText;
  updateSessionHandoffWarning();
  const inferredPreset = recommendPreset({
    jurisdiction: intake.case.jurisdiction,
    riskLevel: intake.case.riskLevel,
    intakeText
  });
  state.recommendedPresetId = options.presetId || inferredPreset;
  state.selectedPresetId = options.presetId || inferredPreset;
  state.showRouteTab = false;
  state.tab = "overview";
  state.dockOpen = true;
  addChat("user", parsed.personLabel || intakeText);
  if (options.autoStartRoute) {
    await startPreset({ quiet: true });
    if (options.pastedUrls?.length) {
      if ($("#findings-paste-input")) {
        $("#findings-paste-input").value = options.pastedUrls.join("\n");
      }
      localStorage.setItem(`oblivion.discoveryUrls.${caseId}`, JSON.stringify(options.pastedUrls));
      await maybeAutoDiscoverFindings({ force: true, quiet: true }).catch(() => {});
      await syncCurrentCaseStatus();
    }
    state.autopilotBusy = true;
    render();
    await agentAutopilot({ silentUser: true }).catch(() => {});
    state.autopilotBusy = false;
    addChat("agent", `Running ${presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
  } else {
    addChat("agent", `Ready — ${presetTitle(state.selectedPresetId)}. Tap Next.`);
  }
  if (state.walletAddress) {
    await linkCurrentCaseToWallet(caseId).catch(() => {});
    await syncWalletCases().catch(() => {});
  }
  saveLocalCases();
  render();
  write(intake);
}

async function linkCurrentCaseToWallet(caseId = state.currentCaseId) {
  if (!state.walletAddress || !caseId) return;
  await request("/api/wallet/cases/link", {
    method: "POST",
    body: { caseId, walletAddress: state.walletAddress }
  });
}

async function syncWalletCases() {
  if (!state.walletAddress) return;
  const result = await request(
    `/api/wallet/cases?walletAddress=${encodeURIComponent(state.walletAddress)}`
  );
  const remote = result.cases || [];
  const byId = new Map(state.cases.map((item) => [item.id, item]));
  for (const item of remote) {
    if (!byId.has(item.id) && getCaseToken(item.id)) {
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
  saveLocalCases();
}

function resetPreSearchUi() {
  state.preSearchReady = false;
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (panel) panel.hidden = true;
  if (list) list.innerHTML = "";
  if (preStatus) preStatus.textContent = "";
  const btn = $("#start-cleanup");
  if (btn) setButtonLabel(btn, "Start cleanup");
}

function renderPreSearchPreview(findings, message) {
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (!panel || !list || !preStatus) return;
  panel.hidden = false;
  preStatus.textContent = message;
  const rows = (findings || []).slice(0, 12);
  if (!rows.length) {
    list.innerHTML = `<li class="muted">No links found yet. Paste URLs above or continue — the agent can search again later.</li>`;
    return;
  }
  list.innerHTML = rows
    .map((item) => {
      const label = shortenUrl(item.sourceUrl);
      return `<li><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${item.title ? ` — ${escapeHtml(item.title)}` : ""}</li>`;
    })
    .join("");
}

async function runPreliminarySearch(parsed) {
  assertCaseActivatedClient();
  const statusEl = $("#simple-start-status");
  const preStatus = $("#pre-search-status");
  if (statusEl) statusEl.textContent = "Searching for exposure…";
  if (preStatus) preStatus.textContent = "Searching…";
  $("#pre-search-panel")?.removeAttribute("hidden");
  await refreshIntegrationsStatus().catch(() => {});
  await startPreset({ quiet: true });
  if (parsed.pastedUrls?.length) {
    if ($("#findings-paste-input")) {
      $("#findings-paste-input").value = parsed.pastedUrls.join("\n");
    }
    localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(parsed.pastedUrls));
  }
  const discovery = await maybeAutoDiscoverFindings({ force: true, quiet: true });
  await syncCurrentCaseStatus();
  const findings = state.currentStatus?.findings || [];
  const searchReady = discoverySearchReady();
  let message = "";
  if (discovery.ran && findings.length) {
    message = `Found ${findings.length} link(s) to review. Continue to start cleanup.`;
  } else if (discovery.reason === "urls-needed" && !searchReady) {
    message = "Automated search is not configured — paste profile URLs above or continue anyway.";
  } else if (discovery.ran) {
    message = "Search complete. No new links yet — you can continue or paste URLs above.";
  } else {
    message = "Ready to continue. The agent can search again from Overview.";
  }
  renderPreSearchPreview(findings, message);
  state.preSearchReady = true;
  const btn = $("#start-cleanup");
  if (btn) setButtonLabel(btn, "Continue cleanup");
  if (statusEl) statusEl.textContent = "";
  addChat("agent", message);
  render();
}

async function continueAfterPreSearch() {
  assertCaseActivatedClient();
  const statusEl = $("#simple-start-status");
  if (statusEl) statusEl.textContent = "Starting cleanup…";
  state.preSearchReady = false;
  state.autopilotBusy = true;
  render();
  try {
    await agentAutopilot({ silentUser: true }).catch(() => {});
    addChat("agent", `Running ${presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
    resetPreSearchUi();
    if (statusEl) statusEl.textContent = "";
    $("#dashboard-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    state.autopilotBusy = false;
    render();
  }
}

async function startSimpleCleanup() {
  const btn = $("#start-cleanup");
  const statusEl = $("#simple-start-status");
  if (btn) btn.disabled = true;
  try {
    if (state.preSearchReady && state.currentCaseId) {
      await continueAfterPreSearch();
      return;
    }
    const parsed = readSimpleIntakeForm();
    syncSimpleFormToLegacyFields(parsed);
    selectPresetId(parsed.presetId);
    if (!state.onboardingPreviewReady && !state.currentCaseId) {
      await runOnboardingPreview();
      return;
    }
    if (!state.walletAddress) {
      if (statusEl) statusEl.textContent = "Connect MetaMask to start…";
      await connectWallet({ openHub: false });
    }
    if (statusEl) statusEl.textContent = "Creating case…";
    await createCase({
      parsed: {
        intakeText: parsed.intakeText,
        jurisdiction: parsed.jurisdiction,
        riskLevel: parsed.riskLevel,
        authorityBasis: parsed.authorityBasis,
        personLabel: parsed.personLabel,
        aliases: parsed.aliases,
        region: parsed.region
      },
      presetId: parsed.presetId,
      pastedUrls: parsed.pastedUrls,
      autoStartRoute: true
    });
    if (statusEl) statusEl.textContent = "";
    $("#dashboard-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const message = paymentErrorMessage(error);
    if (statusEl) {
      setInlineStatus(statusEl, message, {
        baseClass: "muted small simple-status",
        variant: isUserRejectedError(error) ? "warning" : "fail"
      });
    }
    pulseFocusField($("#simple-name"));
    write(error);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function startWithAgent() {
  await startSimpleCleanup();
}

async function startPreset(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  assertCaseActivatedClient({ quiet: options.quiet });
  const result = await request(`/api/cases/${state.currentCaseId}/preset`, {
    method: "POST",
    body: {
      presetId: state.selectedPresetId,
      autonomyMode: $("#high-autonomy-toggle").checked ? "high-autonomy" : "approval-gated"
    }
  });
  state.agentPlan = result.plan;
  state.currentStatus = result.status;
  state.tab = "overview";
  await refreshAgentPlan({ silent: true });
  await refreshHackathon({ silent: true }).catch(() => {});
  if (!options.quiet) addChat("agent", `${presentPreset(result.preset).title} is staged. I can run the route now.`);
  render();
  write(result);
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
  render();
  write(result);
}

async function approve(approvalId) {
  const result = await request(`/api/approvals/${approvalId}/approve`, {
    method: "POST",
    body: { userConfirmation: "I approve this exact action" }
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {});
  await refreshHackathon({ silent: true });
  addChat(
    "agent",
    isLiveExecutorMode()
      ? "Approved. I can execute the live connector path when you confirm — still only what you approved."
      : "Approved. I can record it without external submission."
  );
  state.tab = "overview";
  render();
  write(result);
}

async function executeAction(actionId) {
  const action =
    state.currentStatus?.actionsReady?.find((item) => item.id === actionId) ||
    state.currentStatus?.submittedActions?.find((item) => item.id === actionId);
  const passwordPlaintext =
    action?.actionType === "pwned-password-range-check"
      ? $("#breach-password-vault")?.value || ""
      : "";
  const handoffWarning = handoffReadinessWarning(action);
  if (handoffWarning) {
    addChat("agent", handoffWarning);
    state.sessionHandoffWarning = handoffWarning;
    renderVaultPanel();
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
  await refreshHackathon({ silent: true });
  const live = result.executorMode === "live";
  const mailto = result.connectorResult?.mailtoUrl;
  const handoffNote = mailto
    ? " Use Open in email app to send the approved draft."
    : result.connectorResult?.requiresUserHandoff
      ? " Open the official path to finish submission."
      : "";
  addChat(
    "agent",
    live
      ? `Live connector path: ${result.connectorResult?.summary || result.action?.executionRecord || "executed."}${handoffNote}`
      : "Recorded. No third-party submission without your explicit approval path."
  );
  if (mailto) {
    state.lastMailtoUrl = mailto;
  }
  state.tab = "overview";
  render();
  write(result);
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
  saveLocalCases();
  await loadCase(kit.caseId, { silent: true, openApp: true }).catch(() => {});
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

async function deleteCaseById(caseId, options = {}) {
  if (!caseId) throw { error: "case-required", message: "Select a case." };
  if (!options.skipConfirm) {
    openDeleteCaseModal(caseId);
    return;
  }
  const deleted = await request("/api/delete", {
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
  saveLocalCases();
  closeDeleteCaseModal();
  render();
  write(deleted);
}

async function confirmDeleteCase() {
  const caseId = state.deleteConfirmCaseId || state.currentCaseId;
  if (!caseId) return;
  await deleteCaseById(caseId, { skipConfirm: true });
}

async function deleteCase() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  openDeleteCaseModal(state.currentCaseId);
}

async function refreshWalletConfig() {
  try {
    state.walletConfig = await request("/api/integrations/wallet-config");
    walletLog.info(
      state.walletConfig.liveEnabled
        ? "Payments: Sepolia (WALLET_LIVE_MODE=true)"
        : "Payments: session mode (set WALLET_LIVE_MODE=true for Sepolia on-chain)",
      { chainId: state.walletConfig.chainId, liveEnabled: state.walletConfig.liveEnabled }
    );
  } catch (error) {
    state.walletConfig = { ...DEFAULT_WALLET_CONFIG };
    walletLog.warn("wallet-config unavailable — using embedded defaults", {
      status: error?.error,
      hint: "Restart npm run dev if the server is an old build"
    });
  }
}

async function refreshIntegrationsStatus() {
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

async function ensureWalletProvider() {
  if (!state.walletAddress) await connectWallet({ quiet: true, openHub: false });
  const provider = state.ethereumProvider || (await resolveEthereumProvider());
  if (!provider?.request) throw { error: "no-provider", message: "Install MetaMask to settle x402 payments." };
  return provider;
}

async function settlePaymentForMode(mode, options = {}) {
  if (!isLiveX402Ready(state.integrationsStatus)) {
    state.paymentRailsNotice =
      "x402 is not configured on the API server — settlement was skipped. Set X402_PAY_TO and redeploy.";
    renderPayments();
    return { settled: false, skipped: true, reason: "x402-not-configured" };
  }
  state.paymentRailsNotice = "";
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const sessions = state.hackathon?.payments || [];
  const session = sessions.find((item) => item.productId === (mode === "subscription" ? "credit-monitor" : "credit-starter"));
  if (!session) throw { error: "payment-session-missing", message: "Prepare payment first." };
  if (session.status === "paid") return { settled: true, alreadyPaid: true, session };
  const provider = await ensureWalletProvider();
  if (!options.quiet) {
    state.walletConnectNote = `Confirm ${paymentPlanLabel(mode)} USDC on Base Sepolia in MetaMask…`;
    renderWalletPanels();
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
  await refreshHackathon({ silent: true });
  return result;
}

async function disconnectWallet() {
  const provider = state.ethereumProvider || pickMetaMaskFromWindow();
  await revokeWalletPermissions(provider);
  state.walletAddress = "";
  state.smartAccountAddress = "";
  state.ethereumProvider = null;
  state.walletMode = "";
  state.walletCallsId = "";
  state.smartAccountTxHash = "";
  state.walletConnectError = "";
  state.walletConnectNote = "";
  state.walletPickAccount = true;
  walletLog.info("disconnectWallet");
  toggleWalletModal(false);
  renderWalletPanels();
  render();
}

async function connectWallet(options = {}) {
  state.walletConnectError = "";
  state.walletConnectNote = "Opening MetaMask…";
  state.dockOpen = true;
  renderWalletPanels();
  walletLog.info("connectWallet start", { hasCase: hasActiveCase() });
  let provider = null;
  const pickAccount = Boolean(state.walletPickAccount);
  state.walletPickAccount = false;
  try {
    provider = await resolveEthereumProvider({ forceFresh: pickAccount });
    state.ethereumProvider = provider;
    if (provider?.request) {
      walletLog.info("eth_requestAccounts", { pickAccount });
      const accounts = await requestWalletAccounts(provider, { pickAccount });
      state.walletAddress = accounts?.[0] || "";
      if (!state.walletAddress) {
        throw new Error("No account returned. Unlock MetaMask and try again.");
      }
      state.walletMode = provider.isMetaMask ? "metamask" : "injected";
      state.walletConnectNote = provider.isMetaMask
        ? `MetaMask connected ${shortenAddress(state.walletAddress)}`
        : `Wallet connected ${shortenAddress(state.walletAddress)}`;
      walletLog.info("connected", { address: shortenAddress(state.walletAddress), isMetaMask: provider.isMetaMask });
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
    walletLog.error("connect failed", { code, message: error?.message });
    render();
    write({ error: "wallet-connect-failed", message, code });
    throw error;
  }
  if (options.openHub) openWalletHub();
  else render();
  $("#wallet-feedback-primary")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  await syncWalletCases().catch(() => {});
  await refreshCreditsBalance().catch(() => {});
  write({
    walletAddress: state.walletAddress,
    mode: state.walletMode
  });
  return provider;
}

async function createSmartAccount(options = {}) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start with the agent first — create a case, then enable Smart Account." };
  }
  if (!state.walletAddress) await connectWallet({ quiet: true });
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
  const result = await request("/api/metamask/smart-account-session", {
    method: "POST",
    body
  });
  state.smartAccountAddress = result.smartAccountAddress;
  state.walletMode = result.mode || "live";
  await refreshHackathon({ silent: true });
  if (!options.quiet) {
    const remaining = hackathonPendingTracks();
    addChat(
      "agent",
      remaining.length
        ? `Smart Account ready. Still pending: ${remaining.join(", ")} — use Developer details buttons below.`
        : "Smart Account ready. All sponsor tracks are complete."
    );
  }
  if (options.openHub !== false) openWalletHub();
  else render();
  write(result);
  return result;
}

async function enableSmartAccount(options = {}) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start a cleanup first, then enable Smart Account." };
  }
  if (!state.walletAddress) {
    await connectWallet({ quiet: true, openHub: false });
  }
  state.walletConnectNote = "Enabling Smart Account…";
  renderWalletPanels();
  const provider = state.ethereumProvider || (await resolveEthereumProvider());
  if (state.walletConfig?.liveEnabled && provider?.request) {
    state.walletConnectNote = "Confirm Sepolia Smart Account upgrade in MetaMask…";
    renderWalletPanels();
    const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
    if (liveResult.ok) {
      state.walletCallsId = liveResult.callsId || "";
      state.smartAccountTxHash = liveResult.txHash || "";
      await createSmartAccount({
        mode: "live",
        txHash: liveResult.txHash,
        callsId: liveResult.callsId,
        chainId: liveResult.chainId,
        quiet: options.quiet,
        openHub: options.openHub
      });
      if (!options.quiet) {
        addChat(
          "agent",
          liveResult.txHash
            ? `Smart Account upgrade submitted (${shortenAddress(liveResult.txHash)}).`
            : "Smart Account upgrade sent — confirm in MetaMask if still pending."
        );
      }
      return;
    }
    if (liveResult.reason === "user-rejected") {
      state.walletConnectError = paymentErrorMessage({ reason: "user-rejected", message: liveResult.message });
      render();
      return;
    }
    state.walletConnectError =
      liveResult.message || "Live Smart Account upgrade failed. Confirm Sepolia batch in MetaMask.";
    render();
    throw { error: "smart-account-live-required", message: state.walletConnectError };
  }
  state.walletConnectError = "Smart Account requires WALLET_LIVE_MODE=true and MetaMask on Sepolia.";
  render();
  throw { error: "smart-account-live-required", message: state.walletConnectError };
}

async function connectWalletFlow(options = {}) {
  state.walletConnectError = "";
  try {
    if (!state.walletAddress) {
      state.walletConnectNote = "Connecting MetaMask…";
      renderWalletPanels();
      await connectWallet({ quiet: true, openHub: false });
    }
    if (state.currentCaseId && !state.smartAccountAddress) {
      await enableSmartAccount({ quiet: options.quiet, openHub: options.openHub ?? false });
    } else if (!state.currentCaseId) {
      state.walletConnectNote = `Wallet connected · ${shortenAddress(state.walletAddress)}. Start a cleanup to enable Smart Account.`;
      renderWalletPanels();

    } else if (!options.quiet) {
      addChat("agent", "Wallet and Smart Account are ready.");
    }
    render();
  } catch (error) {
    write(error);
    throw error;
  }
}

async function upgradeMetaMaskLive() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create a case first." };
  if (!state.walletAddress) await connectWallet({ quiet: true });
  const provider = state.ethereumProvider || (await resolveEthereumProvider());
  if (!provider?.request) throw { error: "no-provider", message: "Install MetaMask to use live upgrade." };
  state.walletConnectNote = "Confirm Sepolia upgrade in MetaMask…";
  renderWalletPanels();
  const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
  if (!liveResult.ok) {
    state.walletConnectError = liveResult.message || "Live upgrade failed.";
    render();
    write(liveResult);
    return;
  }
  state.walletCallsId = liveResult.callsId || "";
  state.smartAccountTxHash = liveResult.txHash || "";
  await createSmartAccount({
    mode: "live",
    txHash: liveResult.txHash,
    callsId: liveResult.callsId,
    chainId: liveResult.chainId
  });
}

async function preparePayment(mode, options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!state.walletAddress) await connectWallet({ quiet: true, openHub: false });
  if (!state.smartAccountAddress) await createSmartAccount({ quiet: true, openHub: false });
  await refreshIntegrationsStatus().catch(() => {});
  if (!isLiveX402Ready(state.integrationsStatus)) {
    state.paymentRailsNotice =
      "x402 is not configured on the API server — only a payment-required session was created.";
    renderPayments();
  }
  const productId = mode === "subscription" ? "credit-monitor" : "credit-starter";
  const result = await request(`/api/x402/${mode === "subscription" ? "subscription" : "one-off"}`, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      productId,
      walletAddress: state.walletAddress,
      smartAccountAddress: state.smartAccountAddress
    }
  });
  await refreshHackathon({ silent: true });
  let settlement = null;
  if (!options.skipSettle && isLiveX402Ready(state.integrationsStatus)) {
    try {
      settlement = await settlePaymentForMode(mode, { quiet: options.quiet });
    } catch (error) {
      const message = paymentErrorMessage(error);
      if (options.statusEl) {
        setInlineStatus(options.statusEl, message, {
          baseClass: "muted small onboarding-payment-status",
          variant: isUserRejectedError(error) ? "warning" : "fail"
        });
      }
      if (!options.quiet) {
        state.walletConnectError = message;
        addChat("agent", message);
        throw error;
      }
    }
  }
  renderSubscriptionUpsell();
  if (!options.quiet) openPaymentRails();
  write({ ...result, settlement });
  return { ...result, settlement };
}

async function runVenice(kind) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const path = kind === "draft-request"
    ? "/api/ai/draft-request"
    : kind === "review-approval"
      ? "/api/ai/review-approval"
      : "/api/ai/classify-case";
  if (!state.walletAddress) await connectWallet({ quiet: true, openHub: false });
  const result = await request(path, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      walletAddress: state.walletAddress,
      notes: $("#purpose").value || "Redacted people-search cleanup case.",
      destination: $("#destination").value || "approved broker",
      actionType: state.actionType
    }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  render();
  write(result);
}

async function delegateAgents() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const result = await request("/api/agents/delegate", {
    method: "POST",
    body: { caseId: state.currentCaseId }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  render();
  write(result);
}

async function relayPayment() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  await refreshIntegrationsStatus().catch(() => {});
  if (!state.integrationsStatus?.liveReady?.oneShot) {
    throw {
      error: "oneshot-not-configured",
      message: "Set ONESHOT_API_KEY and OBLIVION_PUBLIC_API_URL on the API server for live 1Shot relay."
    };
  }
  const session =
    [...(state.hackathon?.payments || [])].find((item) => item.status === "paid" && item.mode === "one-off") ||
    [...(state.hackathon?.payments || [])].find((item) => item.status === "paid");
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
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  addChat("agent", `1Shot relay: ${result.events?.at(-1)?.status || "submitted"}.`);
  render();
  write(result);
}

async function askAgent() {
  const text = $("#agent-input").value.trim();
  if (!text) {
    updateAgentSendState();
    return;
  }
  addChat("user", text);
  $("#agent-input").value = "";
  updateAgentSendState();
  const lower = text.toLowerCase();
  if (teeQuestionIntent(lower)) {
    addChat("agent", await buildTeeVerificationBrief());
    state.tab = "trust";
    render();
    return;
  }
  if (!state.currentCaseId) {
    if (!text) {
      addChat("agent", "Describe what to clean up in one sentence — here or in the intake box.");
      render();
      return;
    }
    const intake = $("#agent-intake");
    if (intake) intake.value = text;
    renderIntakeInferencePreview();
    await startWithAgent();
    return;
  }
  if (lower.includes("run") || lower.includes("do it") || lower.includes("continue")) {
    try {
      assertCaseActivatedClient();
      await agentAutopilot();
    } catch (error) {
      if (error?.error === "case-activation-required") {
        addChat("agent", error.message);
        render();
        return;
      }
      throw error;
    }
    return;
  }
  if (lower.includes("disclosure") || lower.includes("explain")) {
    $("#agent-explain-disclosure").click();
    return;
  }
  if (state.integrationsStatus?.liveReady?.venice) {
    try {
      if (!state.walletAddress) await connectWallet({ quiet: true, openHub: false });
      const result = await request("/api/agent/chat", {
        method: "POST",
        body: {
          caseId: state.currentCaseId,
          walletAddress: state.walletAddress,
          message: text || "What should I do next?"
        }
      });
      addChat("agent", result.reply || "No reply.");
      await refreshHackathon({ silent: true });
      render();
      return;
    } catch (error) {
      if (error?.error === "credits-insufficient" || error?.error === "ai-payment-required") {
        addChat(
          "agent",
          "Insufficient wallet credits for Venice AI — buy 500 credits ($5) or subscribe for 1,200/month in Settings → Payment rails."
        );
        openPaymentRails();
        render();
        return;
      }
      addChat("agent", error?.message || "Venice request failed.");
      render();
      return;
    }
  }
  await refreshHackathon({ silent: true });
  const next = state.agentNext;
  addChat("agent", next ? `${shortStepTitle(next.title)}. ${next.message || ""}`.trim() : "Set VENICE_API_KEY on the server for live agent replies.");
  render();
}

async function agentRunNext(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  assertCaseActivatedClient({ quiet: options.quiet });
  await refreshHackathon({ silent: true });
  if (state.agentNext?.action === "select-preset") {
    await startPreset({ quiet: true });
    await refreshHackathon({ silent: true });
  }
  if (state.agentNext?.action === "request-approval" && state.currentStatus?.approvalsNeeded?.length > 0) {
    addChat("agent", "Approval required. Review the card.");
    state.tab = "overview";
    render();
    return;
  }
  if (peopleSearchPresetActive() && needsExposureDiscovery()) {
    const discovery = await maybeAutoDiscoverFindings({ quiet: true });
    await refreshHackathon({ silent: true });
    await syncCurrentCaseStatus();
    if (discovery.reason === "urls-needed") {
      if (!options.quiet) {
        openFindingsPastePanel();
        addChat("agent", "Paste profile URLs under Exposure links, then run the next step again.");
      }
      state.tab = "overview";
      render();
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
      addChat("agent", "Review Exposure links — confirm yours or mark Not me.");
      openFindingsPastePanel();
    }
    state.tab = "overview";
    render();
    return;
  }
  const blocked = state.agentNext?.blockedReasons || [];
  if (blocked.includes("discovery-needed")) {
    if (!options.quiet) {
      openFindingsPastePanel();
      addChat("agent", state.agentNext?.message || "Paste profile URLs to discover listings.");
    }
    state.tab = "overview";
    render();
    return;
  }
  if (blocked.length) {
    if (!options.quiet) addChat("agent", state.agentNext.message || "Paused for review.");
    state.tab = "overview";
    render();
    return;
  }
  if (state.agentNext?.action === "complete") {
    addChat("agent", "Cleanup cycle complete. Open the Trust tab for proof details.");
    render();
    return;
  }
  const result = await request(`/api/cases/${state.currentCaseId}/agent/run`, {
    method: "POST",
    body: {
      highAutonomy: $("#high-autonomy-toggle").checked
    }
  });
  if (result.caseStatus) state.currentStatus = result.caseStatus;
  if (result.plan) state.agentPlan = result.plan;
  if (result.connectorResults) state.connectorResults = result.connectorResults;
  await refreshAgentPlan({ silent: true }).catch(() => {});
  await refreshHackathon({ silent: true });
  await syncCurrentCaseStatus();
  if (!options.quiet) addChat("agent", `${shortStepTitle(result.ran.title)}. Next: ${shortStepTitle(result.next.title)}.`);
  render();
  write(result);
}

async function agentAutopilot(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  assertCaseActivatedClient({ quiet: options.silentUser });
  if (!options.silentUser) addChat("user", "Run route.");
  for (let index = 0; index < 12; index += 1) {
    await refreshHackathon({ silent: true });
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
    await agentRunNext({ quiet: true });
  }
  await refreshHackathon({ silent: true });
  await refreshAgentPlan({ silent: true }).catch(() => {});
  await syncCurrentCaseStatus();
  addChat("agent", state.agentNext?.action === "request-approval"
    ? "Approval required."
    : state.agentNext?.action === "complete"
      ? "Complete. No external submission."
      : state.agentNext?.blockedReasons?.length
        ? state.agentNext.message || "Paused for review."
      : "Paused for review.");
  state.tab = "overview";
  render();
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
    render();
  });
});
document.addEventListener("click", (event) => {

  const starter = event.target.closest("[data-agent-preset]");
  if (!starter) return;
  event.preventDefault();
  applyAgentIntakeTemplate(starter.dataset.agentPreset);
});
$("#show-advanced-ui")?.addEventListener("change", (event) => {
  state.showAdvancedUI = event.target.checked;
  applyAdvancedUiVisibility();
  render();
});
$("#agent-intake")?.addEventListener("input", () => renderIntakeInferencePreview());
$("#agent-intake")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    startSimpleCleanup().catch(write);
  }
});
function openApp() {
  state.appOpen = true;
  state.dockOpen = true;
  state.dockPinned = true;
  location.hash = "app";
  if (state.currentCaseId) {
    loadCase(state.currentCaseId, { silent: true, openApp: false }).catch(write);
    return;
  }
  render();
  focusIntake();
}

function backToLanding() {
  state.appOpen = false;
  state.dockOpen = false;
  location.hash = "";
  render();
  $("#landing-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  localStorage.setItem("oblivion.sidebarOpen", state.sidebarOpen ? "1" : "0");
  render();
}

$("#sidebar-home")?.addEventListener("click", backToLanding);
$("#sidebar-new-case")?.addEventListener("click", () => openNewCaseFlow());
$("#sidebar-collapse")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleSidebar();
});
window.addEventListener("hashchange", () => {
  syncAppRoute();
  if (state.appOpen && state.currentCaseId && !state.currentStatus) {
    loadCase(state.currentCaseId, { silent: true, openApp: false }).catch(() => render());
  } else {
    render();
  }
});

$("#refresh-dashboard")?.addEventListener("click", () => refreshTrust().then(refreshCases).catch(write));
$("#change-route")?.addEventListener("click", () => revealRouteTab());
$("#continue-flow").addEventListener("click", () => revealRouteTab());
$("#local-safe-mode").addEventListener("click", () => {
  $("#require-trust").checked = false;
  revealRouteTab();
});
$("#new-case").addEventListener("click", () => openNewCaseFlow());
$("#case-manager-new")?.addEventListener("click", () => openNewCaseFlow());
$("#toolbar-cases-toggle")?.addEventListener("click", () => toggleCasesPanel());
$("#case-manager-close")?.addEventListener("click", () => toggleCasesPanel(false));
$("#start-preset").addEventListener("click", () => startPreset().catch(write));
$("#propose-action").addEventListener("click", () => proposeAction().catch(write));
$("#wallet-modal-close")?.addEventListener("click", () => toggleWalletModal(false));
$("#wallet-modal-disconnect")?.addEventListener("click", () => disconnectWallet().catch(write));
$("#wallet-modal-settings")?.addEventListener("click", () => {
  toggleWalletModal(false);
  openPaymentRails();
});
$("#wallet-modal-connect")?.addEventListener("click", () => {
  connectWallet({ openHub: true }).catch(write);
});
$("#wallet-modal-live-upgrade")?.addEventListener("click", () => upgradeMetaMaskLive().catch(write));
$("#wallet-modal-smart-account")?.addEventListener("click", () => {
  enableSmartAccount({ quiet: false, openHub: false })
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
    connectWallet({ openHub: walletBtn.id === "wallet-modal-connect" }).catch(write);
  }
});
$("#create-smart-account")?.addEventListener("click", () => createSmartAccount().catch(write));

$("#privacy-filter-toggle")?.addEventListener("change", (event) => {
  state.privacyFilterMode = Boolean(event.target.checked);
  localStorage.setItem("oblivion.privacyFilter", state.privacyFilterMode ? "1" : "0");
  render();
});
$("#agent-voice-toggle")?.addEventListener("change", (event) => {
  state.agentVoiceEnabled = Boolean(event.target.checked);
  setAgentVoiceEnabled(state.agentVoiceEnabled);
});

$("#classify-case").addEventListener("click", () => runVenice("classify-case").catch(write));
$("#draft-request").addEventListener("click", () => runVenice("draft-request").catch(write));
$("#review-approval").addEventListener("click", () => runVenice("review-approval").catch(write));
$("#delegate-agents").addEventListener("click", () => delegateAgents().catch(write));
$("#relay-demo").addEventListener("click", () => relayPayment().catch(write));
$("#agent-send").addEventListener("click", () => askAgent().catch(write));
$("#agent-input").addEventListener("input", updateAgentSendState);
$("#agent-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") askAgent().catch(write);
});
$("#agent-start-recommended").addEventListener("click", () => startPreset().catch(write));
$("#agent-run-next").addEventListener("click", () => agentAutopilot().catch(write));
$("#agent-review-approval").addEventListener("click", () => {
  state.tab = "approvals";
  state.dockOpen = false;
  render();
});
$("#agent-explain-disclosure").addEventListener("click", () => {
  const approval = state.currentStatus?.approvalsNeeded?.[0];
  addChat("agent", approval
    ? `This would disclose ${approval.dataToDisclose.join(", ")} to ${approval.destination}. I will not submit it without approval.`
    : "No disclosure is pending. I will stop before any external identifier is sent.");
  render();
});
function openAgentDock() {
  state.dockPinned = true;
  state.dockOpen = true;
  $("#app-agent-column")?.classList.add("open");
  $("#agent-dock")?.classList.add("open");
  render();
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
  render();
}

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
$("#delete-case-modal-confirm")?.addEventListener("click", () => confirmDeleteCase().catch(write));
$("#delete-case-modal")?.addEventListener("close", () => {
  state.deleteConfirmCaseId = "";
});
$("#delete-case-modal")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeleteCaseModal();
});
document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
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

// One-time delegation for dynamic lists (big win: no per-render rebinds)
function setupDelegates() {
  // Preset grid delegation + data-testid
  const presetGrid = $("#preset-grid");
  if (presetGrid) {
    presetGrid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset-id]");
      if (btn && !btn.disabled) {
        state.selectedPresetId = btn.dataset.presetId;
        if (state.selectedPresetId !== state.recommendedPresetId) state.showRouteTab = true;
        renderPresets();
        renderAgentChat();
        render();
      }
    });
    presetGrid.setAttribute("data-testid", "preset-grid");
  }

  // Agent action cards (approvals + ready)
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

  // Approval table delegation
  const approvalTable = $("#approval-table");
  if (approvalTable) {
    approvalTable.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-approve-id]");
      if (btn) approve(btn.dataset.approveId);
    });
    approvalTable.setAttribute("data-testid", "approval-table");
  }

  // Action table (history)
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
      if (btn) preparePayment(btn.dataset.payMode).catch(write);
    });
  }

  // Case list delegation
  const caseList = $("#case-list");
  if (caseList) {
    caseList.addEventListener("click", (e) => {
      const deleteBtn = e.target.closest("[data-delete-case]");
      if (deleteBtn) {
        e.preventDefault();
        deleteCaseById(deleteBtn.dataset.deleteCase).catch(write);
        return;
      }
      const btn = e.target.closest("[data-case-id]");
      if (btn) {
        state.casesPanelOpen = false;
        loadCase(btn.dataset.caseId);
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
      preparePayment("subscription")
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

setupDelegates();
setupLandingSkillInstall();
setupLandingLocationCombobox();
setupOnboardingRegionCombobox();

syncAppRoute();
await loadApiConfig().catch(() => null);
await refreshPresets().catch(write);
await refreshTrust().catch(write);
await refreshWalletConfig().catch(write);
await refreshIntegrationsStatus().catch(write);
await refreshCases().catch(write);
await refreshHackathon({ silent: true }).catch(write);
render();
