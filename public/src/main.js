import * as Vault from './crypto.js';
import { tryLiveSmartAccountUpgrade } from './metamaskSmartAccount.js';
import { createWalletLogger, DEFAULT_WALLET_CONFIG } from './walletLog.js';
import { bindIcons, setButtonLabel, setIcon } from './icons.js';

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
  hackathon: null,
  hackathonStatus: null,
  integrationsStatus: null,
  agentNext: null,
  chatMessages: [
    {
      role: "agent",
      text: "Hi — I'm your cleanup agent. I find listings, draft opt-outs, and pause for your approval before anything is sent."
    },
    {
      role: "agent",
      text: "Quick start: enter your name on the left, keep People-search selected, then tap Start cleanup. I'll ask you to confirm each match — Yes or Not me."
    }
  ],
  showAdvancedTabs: false,
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
  showRouteTab: false,
  showAdvancedUI: false,
  autopilotBusy: false,
  casesPanelOpen: false,
  walletModalOpen: false
};

const $ = (selector) => document.querySelector(selector);
const output = $("#output");

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
  "high-risk-safety": { jurisdiction: "US", riskLevel: "high-risk-safety" }
};

const AGENT_INTAKE_TEMPLATES = {
  "people-search-cleanup": {
    name: "John Smith",
    alias: "J. Smith",
    region: "New York",
    urls: "",
    chatLine: "People-search cleanup for John Smith in New York (also known as J. Smith)."
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
  if (step === 2) return state.currentStatus?.pendingFindings?.length ? "Continue" : "Keep going";
  if (step === 3) return "Review approval";
  return "Continue";
}

function setupLandingSkillInstall() {
  const origin = window.location.origin;
  const curl = $("#skill-install-curl");
  if (curl) {
    const code = curl.querySelector("code");
    if (code) code.textContent = `curl -fsSL ${origin}/skill.sh | bash`;
  }
}

async function copySkillInstallCommand(targetId, button) {
  const node = document.getElementById(targetId);
  const text = node?.querySelector("code")?.textContent?.trim() || node?.textContent?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prior = button.querySelector(".btn-label")?.textContent;
      setButtonLabel(button, "Copied");
      window.setTimeout(() => setButtonLabel(button, prior || "Copy"), 1400);
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
    if (node.id === "toggle-advanced-tabs") {
      node.hidden = !state.showAdvancedUI;
      return;
    }
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

function readSimpleIntakeForm() {
  const name = $("#simple-name")?.value?.trim();
  if (!name) throw { error: "name-required", message: "Enter your name to continue." };
  const alias = $("#simple-alias")?.value?.trim();
  const region = $("#simple-region")?.value?.trim();
  const presetId = state.selectedPresetId || "people-search-cleanup";
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
    default:
      return `Remove ${name} from people-search and data-broker listings${regionPart}${aliasPart}.`;
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
  const showDashboard = state.appOpen && Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  guide.hidden = !showDashboard;

  const lead = $("#guide-lead");
  if (lead) {
    const active = GUIDE_STEPS[step - 1];
    lead.textContent = showDashboard ? active.hint : "";
  }

  const primary = $("#guide-primary-action");
  const label = guidePrimaryLabel(step);
  setButtonLabel(primary, label);

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
        <span class="guide-checkpoint-icon" data-icon="${item.icon}" aria-hidden="true"></span>
        <span class="guide-checkpoint-label">${escapeHtml(item.title)}</span>
      </li>`;
    }).join("");
    bindIcons(stepsEl);
  }
  const progressTrack = $("#guide-progress-track");
  const progressFill = $("#guide-progress-fill");
  const pct = GUIDE_STEPS.length > 1 ? ((step - 1) / (GUIDE_STEPS.length - 1)) * 100 : 0;
  if (progressTrack) {
    progressTrack.setAttribute("aria-valuenow", String(step));
    progressTrack.setAttribute("aria-valuetext", GUIDE_STEPS[step - 1]?.title || "Working");
  }
  if (progressFill) progressFill.style.width = `${pct}%`;
  renderWorkflowProgress($("#guide-phase-strip"), $("#guide-phase-status"));
  const toggle = $("#toggle-advanced-tabs");
  if (toggle) {
    toggle.textContent = state.showAdvancedTabs ? "Fewer tabs" : "More tabs";
  }

  document.querySelectorAll(".tab-advanced").forEach((tab) => {
    tab.hidden = !state.showAdvancedTabs;
  });
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
    renderWorkflow();
    renderAgentChat();
    renderApprovals();
    renderActions();
  }
}

function pillClass(value) {
  if (value === true || value === "pass" || value === "used" || value === "ready") return "pill pass";
  if (value === false || value === "fail" || value === "blocked") return "pill fail";
  return "pill warn";
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

function redactedScopeFromIntake(parsed) {
  const text = parsed.intakeText || "";
  const aliases = [...(parsed.aliases || [])];
  const approvedIdentifierLabels = [];
  if (parsed.personLabel && parsed.personLabel !== "Private case") {
    approvedIdentifierLabels.push("legal-name");
  }
  if (parsed.region || /(massachusetts|\bma\b|city-state|address|phone)/i.test(text)) {
    approvedIdentifierLabels.push("city-state");
  }
  if (/(email)/i.test(text)) approvedIdentifierLabels.push("email");
  const sensitiveConstraints = [];
  if (parsed.region) sensitiveConstraints.push(parsed.region);
  else if (/massachusetts/i.test(text)) sensitiveConstraints.push("Massachusetts");
  return {
    personLabel: parsed.personLabel,
    aliases,
    approvedIdentifierLabels,
    sensitiveConstraints
  };
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
  return presetId === "people-search-cleanup" || presetId === "high-risk-safety";
}

function needsExposureDiscovery() {
  const step = state.agentNext?.action || state.agentPlan?.currentStep;
  const blocked = state.agentNext?.blockedReasons || state.agentPlan?.blockedReasons || [];
  if (step !== "discover-candidates" && !blocked.includes("discovery-needed")) return false;
  const pending = state.currentStatus?.pendingFindings?.length ?? 0;
  const total = state.currentStatus?.findings?.length ?? 0;
  return pending === 0 && total === 0;
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
  if (/google/.test(text)) return "search-result-suppression";
  if (/(people-search|people search|profile|address)/.test(text)) return "people-search-cleanup";
  if (/(search|result)/.test(text)) return "search-result-suppression";
  return jurisdiction === "EU" || jurisdiction === "UK" ? "gdpr-erasure" : "people-search-cleanup";
}

function selectedPreset() {
  return state.presets.find((preset) => preset.id === state.selectedPresetId) || null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderChatBubble(message) {
  const role = message.role === "user" ? "user" : "agent";
  const avatarIcon = role === "user" ? "user" : "message";
  const avatarLabel = role === "user" ? "You" : "Agent";
  const body = `<div class="chat-bubble ${role}">${escapeHtml(message.text)}</div>`;
  const avatar = `<span class="chat-avatar chat-avatar-${role}" title="${avatarLabel}" aria-label="${avatarLabel}" data-icon="${avatarIcon}"></span>`;
  if (role === "user") {
    return `<div class="chat-row user" data-chat-role="user">${body}${avatar}</div>`;
  }
  return `<div class="chat-row agent" data-chat-role="agent">${avatar}${body}</div>`;
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
  if (state.currentCaseId) localStorage.setItem("oblivion.currentCaseId", state.currentCaseId);
}

function loadLocalCases() {
  try {
    return JSON.parse(localStorage.getItem("oblivion.caseSummaries") || "[]");
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
  const localCases = loadLocalCases();
  try {
    const remote = await request("/api/cases");
    const byId = new Map(localCases.map((item) => [item.id, item]));
    for (const item of remote.cases) byId.set(item.id, item);
    state.cases = [...byId.values()];
    saveLocalCases();
  } catch {
    state.cases = localCases;
  }
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
  $("#trust-strip").innerHTML = `
    <span class="chip pass" data-testid="trust-vault" data-icon="lock" title="Vault locked">Vault</span>
    <span class="${chipClass(!privacy.serverCanDecryptCaseVault)}" data-testid="trust-server" data-icon="eye-closed" title="Server blind">Blind</span>
    <span class="${chipClass(runtime.state)}" data-testid="trust-runtime" data-icon="cast" title="${escapeHtml(runtime.text)}">${escapeHtml(runtime.text)}</span>
  `;
  const teeClass = pillClass(runtime.state);
  const teeNodes = ["#tee-status", "#command-tee-status"].map((sel) => $(sel)).filter(Boolean);
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
  state.currentCaseId = "";
  state.currentStatus = null;
  state.agentPlan = null;
  state.connectorResults = [];
  state.recommendedPresetId = "people-search-cleanup";
  state.selectedPresetId = "people-search-cleanup";
  state.showRouteTab = false;
  state.casesPanelOpen = false;
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
  const panel = $("#case-manager");
  const countLabel = $("#case-count-label");
  const toggleBtn = $("#toolbar-cases-toggle");
  if (!list) return;

  if (toggleBtn) {
    toggleBtn.hidden = !state.appOpen;
    toggleBtn.setAttribute("aria-expanded", state.casesPanelOpen ? "true" : "false");
    toggleBtn.classList.toggle("active", state.casesPanelOpen);
    setButtonLabel(toggleBtn, state.cases.length ? `Cases (${state.cases.length})` : "Cases");
  }
  if (panel) panel.hidden = !state.appOpen || !state.casesPanelOpen;
  if (countLabel) {
    countLabel.textContent = state.cases.length
      ? `${state.cases.length} saved`
      : "No saved cases";
  }

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
        <button type="button" class="case-button${active}" data-case-id="${item.id}">
          <strong>${escapeHtml(label)}</strong>
          <span class="muted small">${escapeHtml(meta)}</span>
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

function renderWorkflowProgress(phasesTarget, statusTarget) {
  if (!state.agentPlan) {
    if (phasesTarget) phasesTarget.innerHTML = "";
    if (statusTarget) statusTarget.textContent = "";
    return;
  }
  const step = state.agentPlan.currentStep;
  const order = WORKFLOW_PHASES.map((phase) => phase.id);
  const index = Math.max(0, order.indexOf(step));
  const statusLine = workflowStatusLine();
  if (phasesTarget) {
    phasesTarget.innerHTML = WORKFLOW_PHASES.slice(0, 7)
      .map((phase, i) => {
        const done = i < index;
        const active = phase.id === step;
        return `<span class="progress-phase ${done ? "done" : ""} ${active ? "active" : ""}">${escapeHtml(phase.label)}</span>`;
      })
      .join("");
  }
  if (statusTarget) statusTarget.textContent = statusLine;
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
  }
  workspace?.classList.toggle("simple-mode", !state.showAdvancedUI);
  agentColumn?.classList.toggle("collapsed", state.appOpen && !state.dockPinned);
  $("#onboarding-region")?.classList.toggle("active", state.appOpen && !hasCase);
  $("#dashboard-region")?.classList.toggle("active", state.appOpen && hasCase);
  applyAdvancedUiVisibility();
  const dockCollapse = $("#agent-dock-collapse");
  if (dockCollapse) {
    dockCollapse.setAttribute("aria-expanded", state.dockPinned ? "true" : "false");
    dockCollapse.setAttribute("aria-label", state.dockPinned ? "Hide agent panel" : "Show agent panel");
    setButtonLabel(dockCollapse, state.dockPinned ? "Hide" : "Show");
    setIcon(dockCollapse, state.dockPinned ? "minus" : "plus");
  }
  $("#agent-dock")?.classList.toggle("agent-dock-expanded", state.dockPinned);
}

function renderDashboard() {
  const caseRecord = currentCase();
  const status = state.currentStatus;
  if (!caseRecord) return;
  const label = caseRecord.redactedScope?.personLabel || "Private case";
  $("#case-heading").textContent = label;
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
          : "Add links below or tap Next.";
  }

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
      : `<div class="empty">No links yet. Paste URLs above or run Discover.</div>`;
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
            <div class="muted small">${escapeHtml(finding.removalStatus || "not-started")}</div>
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

async function maybeAutoDiscoverFindings(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!options.force && (!peopleSearchPresetActive() || !needsExposureDiscovery())) {
    return { ran: false, reason: "not-needed" };
  }
  const pastedUrls = discoveryUrlHints();
  const braveReady = Boolean(state.integrationsStatus?.liveReady?.braveSearch);
  if (!pastedUrls.length && !braveReady) {
    if (!options.quiet) {
      openFindingsPastePanel();
      addChat("agent", "Paste profile URLs under Exposure links (one per line), then Discover or Run next step.");
    }
    return { ran: false, reason: "urls-needed" };
  }
  const result = await request(`/api/cases/${state.currentCaseId}/findings/discover`, {
    method: "POST",
    body: { pastedUrls }
  });
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
}

async function discoverFindings() {
  const discovery = await maybeAutoDiscoverFindings({ force: true, quiet: false });
  if (!discovery.ran && discovery.reason === "urls-needed") {
    throw { error: "urls-required", message: "Paste at least one profile URL under Exposure links." };
  }
  if (discovery.ran && !discovery.discovered) {
    await syncCurrentCaseStatus();
  }
  render();
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

function renderWorkflow() {
  const plan = state.agentPlan;
  const nodes = plan?.visualNodes?.length
    ? plan.visualNodes
    : [
        ["collect-minimum-identifiers", "Vault", "Vault", "Collect only what the route needs."],
        ["discover-candidates", "Scout", "Scout", "Find exposure candidates from approved sources."],
        ["verify-removal-path", "Verify", "Verifier", "Check official removal paths."],
        ["draft-actions", "Draft", "Draft", "Prepare request text."],
        ["request-approval", "Approve", "User", "Review disclosure before action."],
        ["execute-approved-action", "Submit", "Connector", "Record or execute approved work."],
        ["schedule-recheck", "Recheck", "Scheduler", "Look for recurrence later."]
      ].map(([id, label, actor, detail], index) => ({
        id,
        label,
        actor,
        detail,
        status: index === 0 ? "active" : "pending"
      }));
  const stepPill = $("#plan-step-pill");
  if (stepPill) {
    stepPill.textContent = plan ? titleForAction(plan.currentStep) : "Choose preset";
    stepPill.className = pillClass(plan?.blockedReasons?.length ? "blocked" : plan ? "ready" : "warn");
  }

  const workflowPanel = $("#workflow-panel");
  const canvas = $("#workflow-canvas");
  const showWorkflow = Boolean(state.currentCaseId && plan);
  if (workflowPanel) workflowPanel.hidden = !showWorkflow;
  if (!canvas) {
    const summary = $("#plan-summary");
    if (summary) summary.innerHTML = "";
    return;
  }
  canvas.hidden = !showWorkflow;
  canvas.setAttribute("aria-hidden", showWorkflow ? "false" : "true");
  if (!showWorkflow) {
    const summary = $("#plan-summary");
    if (summary) summary.innerHTML = "";
    return;
  }
  // Use data attrs + targeted updates where possible (first paint builds skeleton)
  if (!canvas.dataset.built) {
    canvas.innerHTML = nodes.map((node) => `
      <div class="workflow-node" data-id="${node.id}" data-status="${node.status}" data-testid="workflow-node">
        <span>${escapeHtml(node.actor)}</span>
        <strong>${escapeHtml(node.label)}</strong>
        <p>${escapeHtml(node.detail)}</p>
      </div>
    `).join("");
    canvas.dataset.built = "true";
  } else {
    nodes.forEach((n) => {
      const el = canvas.querySelector(`[data-id="${n.id}"]`);
      if (el) {
        el.setAttribute("data-status", n.status);
        // micro motion hook
        if (n.status === "active") el.classList.add("is-advancing");
        else el.classList.remove("is-advancing");
      }
    });
  }

  const summary = $("#plan-summary");
  if (summary) {
    summary.innerHTML = `
      <div><span class="muted small">Route</span><br /><strong>${escapeHtml(presetTitle(plan?.presetId) || "Select a preset")}</strong></div>
      <div><span class="muted small">Next decision</span><br /><strong>${escapeHtml(plan?.nextUserDecision || "Pick a cleanup route.")}</strong></div>
      <div><span class="muted small">Disclosure</span><br /><strong>${(state.currentStatus?.approvalsNeeded?.length || 0) > 0 ? "approval waiting" : "locked"}</strong></div>
    `;
  }
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

async function refreshHackathon(options = {}) {
  const products = await request("/api/x402/products");
  state.products = products.products || [];
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

function addChat(role, text) {
  state.chatMessages.push({ role, text });
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
    "Record approved action": "Action recorded",
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
    return { state: "Start", message: "Enter your name → Start cleanup.", actions: [] };
  }
  if (!state.walletAddress && state.showAdvancedUI) {
    return { state: "Wallet", message: "Optional: connect wallet in the header bar.", actions: [] };
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
    return { state: "Record", message: "Tap Next to record approved work.", actions: ["run"] };
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
    "execute-approved-action": "Ready to record.",
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

function renderHackathonChecklist() {
  const target = $("#hackathon-checklist");
  if (!target) return;
  const veniceLive = state.integrationsStatus?.liveReady?.venice;
  const oneShotLive = state.integrationsStatus?.liveReady?.oneShot;
  $("#relay-demo")?.toggleAttribute("hidden", !oneShotLive);
  $("#delegate-agents")?.toggleAttribute("hidden", !veniceLive);
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
  target.innerHTML = rows.map(([label, value]) => `
    <div class="status-row">
      <span>${label}</span>
      <strong class="${pillClass(value)}">${value ? "ready" : "pending"}</strong>
    </div>
  `).join("");
}

function renderAgentPresetStarters() {
  const panel = $("#agent-template-panel");
  const container = $("#agent-preset-starters");
  if (!panel || !container) return;
  const show = state.appOpen;
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
    brief.textContent = state.appOpen && !currentCase()
      ? "Pick a template below — it fills the chat and the main form."
      : prompt.message;
  }
  const live = $("#agent-live");
  if (live) live.textContent = `${prompt.state}. ${prompt.message}`;

  renderAgentPresetStarters();

  const log = $("#agent-chat-messages");
  const logShell = $("#agent-chat-log");
  if (log) {
    const transcript = [...state.chatMessages];
    if (state.appOpen && !currentCase() && transcript.length <= 2) {
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
  }
  if (prompt.actions.includes("review")) phrases.push("Review approval");
  if (prompt.actions.includes("explain")) phrases.push("Explain disclosure");
  if (currentCase()) {
    phrases.push("Keep going");
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
        <button data-chat-execute-id="${action.id}" data-testid="record-action">Record action</button>
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
  if (shouldOpen && state.walletAddress) {
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
  body.innerHTML = `
    <div class="status-list wallet-modal-status">
      <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
      <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
      <div class="status-row"><span>Mode</span><strong>${escapeHtml(mode)}</strong></div>
    </div>
    ${state.walletConnectNote ? `<p class="muted small">${escapeHtml(state.walletConnectNote)}</p>` : ""}
    ${state.walletConnectError ? `<p class="wallet-connect-feedback fail">${escapeHtml(state.walletConnectError)}</p>` : ""}
  `;
  const smartBtn = $("#wallet-modal-smart-account");
  if (smartBtn) {
    smartBtn.hidden = !state.currentCaseId || Boolean(state.smartAccountAddress);
  }
}

function renderWalletFeedback() {
  const errorText = state.walletConnectError || "";
  const primary = $("#wallet-feedback-primary");
  if (primary) {
    primary.className = errorText ? "visually-hidden wallet-connect-feedback fail" : "visually-hidden wallet-connect-feedback";
    primary.textContent = errorText;
  }
  document.querySelectorAll("[data-wallet-feedback-secondary]").forEach((node) => {
    if (errorText) {
      node.hidden = false;
      node.className = "wallet-connect-feedback fail";
      node.textContent = errorText;
    } else {
      node.hidden = true;
      node.textContent = "";
    }
  });
  const onboardingFb = $("#wallet-feedback-onboarding");
  if (onboardingFb) {
    onboardingFb.textContent = "";
  }
}

function openWalletHub() {
  state.showAdvancedTabs = true;
  state.tab = "settings";
  state.dockOpen = false;
  render();
  window.setTimeout(() => {
    $("#wallet-hub")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("#wallet-feedback-primary")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, 80);
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
    if (!state.walletAddress) primary.setAttribute("data-connect-wallet", "");
    else primary.setAttribute("data-wallet-modal", "");
  }
  const liveBtn = $("#upgrade-metamask-live");
  if (liveBtn) {
    liveBtn.hidden = !state.walletConfig?.liveEnabled || !state.walletAddress;
  }
  const hint = $("#wallet-live-hint");
  if (hint) {
    hint.textContent = state.walletConfig?.liveEnabled
      ? "Sepolia Smart Account upgrade uses MetaMask wallet_sendCalls (EIP-5792)."
      : "Smart Account records EIP-7702 + ERC-7715 permissions for your case. Enable WALLET_LIVE_MODE for Sepolia on-chain upgrade.";
  }
  if (state.walletModalOpen && state.walletAddress) renderWalletModal();
}

function renderWalletPanels() {
  const wallet = state.walletAddress || "Not connected";
  const smart = state.smartAccountAddress || "Not created";
  const rows = `
    <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
    <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
  `;
  const onboardingWallet = $("#onboarding-wallet-status");
  const settingsWallet = $("#wallet-status");
  if (onboardingWallet) onboardingWallet.innerHTML = rows;
  if (settingsWallet) settingsWallet.innerHTML = rows;
  const settingsConnect = $("#connect-wallet");
  const settingsDisconnect = $("#disconnect-wallet");
  if (settingsConnect) settingsConnect.hidden = Boolean(state.walletAddress);
  if (settingsDisconnect) settingsDisconnect.hidden = true;
  renderWalletFeedback();
  renderWalletCommandStrip();
}

function renderPayments() {
  renderWalletPanels();
  $("#product-list").innerHTML = state.products.length
    ? state.products.map((product) => `
        <div class="stack-card">
          <strong>${escapeHtml(product.name)}</strong>
          <div class="muted small">${escapeHtml(product.description)}</div>
          <div class="toolbar">
            <span class="pill">${product.mode}</span>
            <span class="pill">${product.amountUsd} ${product.token}</span>
            <span class="pill">${product.cadence || "one time"}</span>
          </div>
        </div>
      `).join("")
    : `<div class="empty">Payment products are loading.</div>`;
  const payments = state.hackathon?.payments || [];
  $("#payments-table").innerHTML = payments.length
    ? payments.map((session) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(session.productId)}</strong>
            <div class="muted small">${session.mode} · ${session.amountUsd} ${session.token} · ${session.status}</div>
          </div>
          <span class="${pillClass(session.status === "payment-required")}">x402</span>
        </div>
      `).join("")
    : `<div class="empty">No payment session yet. Prepare one-off or weekly monitor payment.</div>`;
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
          <span class="${pillClass(event.status === "confirmed" ? "pass" : "warn")}">1Shot</span>
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
  document.querySelectorAll("[data-approve-id]").forEach((button) => {
    button.addEventListener("click", () => approve(button.dataset.approveId));
  });
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
          ${action.executionStatus === "ready" ? `<button data-execute-id="${action.id}">Record</button>` : `<span class="${pillClass(action.executionStatus)}">${action.executionStatus}</span>`}
        </div>
      `).join("")
    : `<div class="empty">No actions yet. Approved tasks will appear here.</div>`;
  document.querySelectorAll("[data-execute-id]").forEach((button) => {
    button.addEventListener("click", () => executeAction(button.dataset.executeId));
  });
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

function render() {
  renderTrust();
  renderCases();
  renderShell();
  renderUserGuide();
  renderWalletCommandStrip();
  renderIntakeInferencePreview();
  renderDashboard();
  renderWorkflow();
  renderFindings();
  renderPresets();
  renderAgentChat();
  renderHackathonChecklist();
  renderPayments();
  renderAgentNetwork();
  renderRelayer();
  renderApprovals();
  renderActions();
  renderTabs();
  updateAgentSendState();
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

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if (!response.ok) throw json;
  return json;
}

async function createCase(options = {}) {
  state.appOpen = true;
  state.dockOpen = true;
  location.hash = "app";
  const parsed = options.parsed
    ? { ...options.parsed }
    : parseIntakeForCase(options.intakeText ?? $("#agent-intake")?.value ?? $("#intake")?.value ?? "");
  if (!parsed.intakeText) {
    throw { error: "intake-required", message: "Enter your name to continue." };
  }
  applyParsedIntakeToForm(parsed);

  const created = await request("/api/cases", {
    method: "POST",
    body: {
      jurisdiction: parsed.jurisdiction,
      authorityBasis: parsed.authorityBasis,
      riskLevel: parsed.riskLevel
    }
  });
  const caseId = created.case.id;
  const intakeText = parsed.intakeText;
  if (!state.vaultKey) state.vaultKey = await Vault.createVaultKey();
  const encryptedIntake = await Vault.encryptPayload(state.vaultKey, { notes: intakeText }, caseId);
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
  state.agentPlan = null;
  state.connectorResults = [];
  state.intakeText = intakeText;
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
  saveLocalCases();
  render();
  write(intake);
}

async function startSimpleCleanup() {
  const btn = $("#start-cleanup");
  const statusEl = $("#simple-start-status");
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = "Starting…";
  try {
    const parsed = readSimpleIntakeForm();
    syncSimpleFormToLegacyFields(parsed);
    selectPresetId(parsed.presetId);
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
    const message = error?.message || "Could not start cleanup.";
    if (statusEl) statusEl.textContent = message;
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
  addChat("agent", "Approved. I can record it without external submission.");
  state.tab = "overview";
  render();
  write(result);
}

async function executeAction(actionId) {
  const result = await request(`/api/actions/${actionId}/execute`, {
    method: "POST",
    body: {}
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {});
  await refreshHackathon({ silent: true });
  addChat("agent", "Recorded. No third-party submission.");
  state.tab = "overview";
  render();
  write(result);
}

async function exportCase() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  const exported = await request("/api/export", {
    method: "POST",
    body: { caseId: state.currentCaseId }
  });
  const passphrase = $("#export-passphrase").value;
  write({
    format: "oblivion-encrypted-case-v1",
    exportedAt: new Date().toISOString(),
    wrappedVaultKey: passphrase ? await Vault.wrapVaultKey(state.vaultKey, passphrase) : undefined,
    payload: exported
  });
}

async function deleteCaseById(caseId, options = {}) {
  if (!caseId) throw { error: "case-required", message: "Select a case." };
  if (!options.skipConfirm) {
    const label = state.cases.find((item) => item.id === caseId)?.redactedScope?.personLabel || "this case";
    if (!confirm(`Delete ${label}? Server data will be purged and cannot be recovered.`)) return;
  }
  const deleted = await request("/api/delete", {
    method: "POST",
    body: { caseId }
  });
  state.cases = state.cases.filter((item) => item.id !== caseId);
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
  render();
  write(deleted);
}

async function deleteCase() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  await deleteCaseById(state.currentCaseId, { skipConfirm: false });
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
  } catch {
    state.integrationsStatus = null;
  }
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
        ? "Cancelled in MetaMask."
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
  const body = {
    caseId: state.currentCaseId,
    walletAddress: state.walletAddress,
    mode: options.mode || (state.walletMode === "live" ? "live" : "demo"),
    txHash: options.txHash || state.smartAccountTxHash || undefined,
    callsId: options.callsId || state.walletCallsId || undefined,
    chainId: options.chainId || state.walletConfig?.chainId
  };
  const result = await request("/api/metamask/demo-session", {
    method: "POST",
    body
  });
  state.smartAccountAddress = result.smartAccountAddress;
  state.walletMode = result.mode || body.mode;
  await refreshHackathon({ silent: true });
  if (!options.quiet) {
    addChat("agent", "Smart Account ready. Checklist updated — try x402 one-off next.");
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
      state.walletConnectError = "Smart Account upgrade cancelled in MetaMask.";
      render();
      return;
    }
  }
  await createSmartAccount({ quiet: options.quiet, openHub: options.openHub });
  if (!options.quiet) {
    addChat("agent", "Smart Account ready (EIP-7702 + ERC-7715). Open Payments for x402.");
  }
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

async function preparePayment(mode) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!state.smartAccountAddress) await createSmartAccount();
  const productId = mode === "subscription" ? "weekly-monitor" : "broker-opt-out-packet";
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
  state.tab = "settings";
  render();
  write(result);
}

async function runVenice(kind) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const path = kind === "draft-request"
    ? "/api/ai/draft-request"
    : kind === "review-approval"
      ? "/api/ai/review-approval"
      : "/api/ai/classify-case";
  const result = await request(path, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
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

async function relayDemo() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const latest = [...(state.hackathon?.payments || [])].at(-1);
  if (!latest) await preparePayment("one-off");
  const session = [...(state.hackathon?.payments || [])].at(-1);
  const result = await request("/api/1shot/relay-demo", {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      sessionId: session?.id
    }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
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
  const lower = text.toLowerCase();
  if (lower.includes("run") || lower.includes("do it") || lower.includes("continue")) {
    await agentAutopilot();
    return;
  }
  if (lower.includes("disclosure") || lower.includes("explain")) {
    $("#agent-explain-disclosure").click();
    return;
  }
  if (state.integrationsStatus?.liveReady?.venice) {
    try {
      const result = await request("/api/agent/chat", {
        method: "POST",
        body: { caseId: state.currentCaseId, message: text || "What should I do next?" }
      });
      addChat("agent", result.reply || "No reply.");
      await refreshHackathon({ silent: true });
      render();
      return;
    } catch (error) {
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
    addChat("agent", "Cleanup cycle complete. Settings contain proof details.");
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
$("#simple-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startSimpleCleanup().catch(write);
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

$("#guide-primary-action")?.addEventListener("click", () => performGuidePrimaryAction().catch(write));
$("#agent-do-next")?.addEventListener("click", () => {
  const label = guidePrimaryLabel(currentGuideStep());
  fillAgentInput(label);
});
$("#toggle-advanced-tabs")?.addEventListener("click", () => {
  state.showAdvancedTabs = !state.showAdvancedTabs;
  if (!state.showAdvancedTabs && ["vault", "history", "settings"].includes(state.tab)) {
    state.tab = "overview";
  }
  render();
});
$("#open-app-hero").addEventListener("click", openApp);
$("#toolbar-home")?.addEventListener("click", backToLanding);
window.addEventListener("hashchange", () => {
  syncAppRoute();
  if (state.appOpen && state.currentCaseId && !state.currentStatus) {
    loadCase(state.currentCaseId, { silent: true, openApp: false }).catch(() => render());
  } else {
    render();
  }
});
$("#jump-how-it-works").addEventListener("click", () => {
  $("#install-skill")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  openWalletHub();
});
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
    connectWallet({ openHub: walletBtn.id === "connect-wallet" && hasActiveCase() }).catch(write);
  }
});

$("#upgrade-metamask-live")?.addEventListener("click", () => upgradeMetaMaskLive().catch(write));
$("#create-smart-account")?.addEventListener("click", () => createSmartAccount().catch(write));
$("#one-off-pay").addEventListener("click", () => preparePayment("one-off").catch(write));
$("#subscription-pay").addEventListener("click", () => preparePayment("subscription").catch(write));
$("#classify-case").addEventListener("click", () => runVenice("classify-case").catch(write));
$("#draft-request").addEventListener("click", () => runVenice("draft-request").catch(write));
$("#review-approval").addEventListener("click", () => runVenice("review-approval").catch(write));
$("#delegate-agents").addEventListener("click", () => delegateAgents().catch(write));
$("#relay-demo").addEventListener("click", () => relayDemo().catch(write));
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
$("#export").addEventListener("click", () => exportCase().catch(write));
$("#delete").addEventListener("click", () => deleteCase().catch(write));
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
  // Workflow canvas (for future node clicks / keyboard)
  const workflow = $("#workflow-canvas");
  if (workflow) {
    workflow.addEventListener("click", (e) => {
      const node = e.target.closest(".workflow-node");
      if (node) {
        // Example: focus the step in dock
        const step = node.dataset.id || node.querySelector("strong")?.textContent;
        if (step) addChat("agent", `Focusing on ${step}.`);
      }
    });
    workflow.setAttribute("data-testid", "workflow-canvas");
  }

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

  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-target]");
    if (!copyBtn) return;
    e.preventDefault();
    copySkillInstallCommand(copyBtn.dataset.copyTarget, copyBtn).catch(write);
  });
}

setupDelegates();
setupLandingSkillInstall();

syncAppRoute();
await refreshPresets().catch(write);
await refreshTrust().catch(write);
await refreshWalletConfig().catch(write);
await refreshIntegrationsStatus().catch(write);
await refreshCases().catch(write);
render();
