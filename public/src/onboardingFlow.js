import { PANELS } from "./renderScheduler.js";
import { isHackathonMode as isHackathonModeForState } from "./refresh.js";
import { setButtonLabel } from "./icons.js";
import { setAnimatedStatus } from "./uiHelpers.js";

export const LANDING_LOCATION_OPTIONS = [
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

export function bindOnboardingFlow(deps) {
  const {
    state,
    $,
    request,
    escapeHtml,
    paymentErrorMessage,
    isUserRejectedError,
    setInlineStatus,
    SIMPLE_PRESET_DEFAULTS,
    AGENT_INTAKE_TEMPLATES,
    parseIntakeForCase,
    urlsFromText,
    selectPresetId,
    onboardingPresetId,
    readSimpleIntakeForm,
    intakeTextForPreset,
    syncJurisdictionFromRegionLabel,
    presentPreset,
    presetTitle,
    currentCase,
    createCaseFlow,
    connectWalletFlow,
    agentAutopilotFlow,
    syncCurrentCaseStatus,
    refreshIntegrationsStatus
  } = deps;

  function isHackathonMode() {
    return isHackathonModeForState(state);
  }

  function setupLocationCombobox({ input, menu, toggle, field, options = LANDING_LOCATION_OPTIONS, onEnter }) {
    if (!input || !menu) return;
    if (field?.dataset.comboboxWired === "1") return;
    if (field) field.dataset.comboboxWired = "1";

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
      deps.updateLandingSendState?.();
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
      deps.write({ error: "copy-failed", message: "Could not copy install command." });
    }
  }

  function fillAgentInput(text) {
    const input = $("#agent-input");
    if (!input) return;
    input.value = text;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    deps.updateAgentSendState();
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
      deps.render();
      $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => pulseFocusField($("#agent-input")), 120);
      return;
    }
    $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => pulseFocusField(intake || $("#agent-input")), 120);
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

  function fieldValue(id) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el || !("value" in el)) return "";
    const raw = el.dataset.privacyRealValue ?? el.value;
    return String(raw).trim();
  }

  function setFieldValue(id, value) {
    const el = $(`#${id}`);
    if (!el || !("value" in el)) return;
    el.value = value;
    if (el.dataset.privacyRealValue !== undefined) {
      el.dataset.privacyRealValue = value;
    }
  }

  function clearIntakeFields() {
    ["simple-name", "simple-alias", "simple-region", "simple-urls"].forEach((id) => {
      const field = $(`#${id}`);
      if (!field) return;
      field.value = "";
      delete field.dataset.privacyRealValue;
    });
  }

  function resetPreSearchUi() {
    state.preSearchReady = false;
    const panel = $("#pre-search-panel");
    const list = $("#pre-search-results");
    const preStatus = $("#pre-search-status");
    if (panel) panel.hidden = true;
    if (list) list.innerHTML = "";
    setAnimatedStatus(preStatus, "", false);
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
        const label = deps.shortenUrl(item.sourceUrl);
        return `<li><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${item.title ? ` — ${escapeHtml(item.title)}` : ""}</li>`;
      })
      .join("");
  }

  function openNewCaseFlow(options = {}) {
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
    state.onboardingPreviewUrls = [];
    localStorage.removeItem("oblivion.currentCaseId");
    clearIntakeFields();
    const seed = options.intake;
    if (seed?.name) setFieldValue("simple-name", seed.name);
    if (seed?.region) setFieldValue("simple-region", seed.region);
    const statusEl = $("#simple-start-status");
    if (statusEl) statusEl.textContent = "";
    focusIntake();
    deps.render();
  }

  async function startFromLanding() {
    const text = fieldValue("#landing-input");
    const region = fieldValue("#landing-location");
    if (!text) {
      pulseFocusField($("#landing-input"));
      deps.updateLandingSendState();
      return;
    }
    openNewCaseFlow({ intake: { name: text, region } });
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
    deps.render(PANELS.intakeInferencePreview);
    if ($("#landing-input")) $("#landing-input").value = "";
    if ($("#landing-location")) $("#landing-location").value = "";
    deps.updateLandingSendState();
    filterDefaultWelcomeChat();
    deps.addChat("user", region ? `${name} · ${region}` : name);
    deps.render(PANELS.shell, PANELS.agentChat, PANELS.onboardingSteps, PANELS.intakeInferencePreview);
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
    deps.addChat("user", template.chatLine);
    deps.addChat(
      "agent",
      `${presentPreset({ id: presetId }).title} template loaded in the main form. Edit anything on the left, then tap Start cleanup.`
    );
    deps.render(PANELS.intakeInferencePreview);
    deps.render(PANELS.shell, PANELS.agentChat, PANELS.onboardingSteps);
    pulseFocusField(nameEl);
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
    setAnimatedStatus(preStatus, "Checking people-search brokers", true);
    if (list) list.innerHTML = "";
    $("#pre-search-panel")?.removeAttribute("hidden");
    if (btn) btn.disabled = true;
    if (landingSend) landingSend.disabled = true;
    if (statusEl) statusEl.textContent = "";
    deps.render(PANELS.onboardingSteps);
    const regionNote = region ? ` in ${region}` : "";
    deps.addChat("agent", `Checking people-search brokers for ${name}${regionNote}…`);
    deps.render(PANELS.agentChat);
    try {
      const result = await request("/api/discovery/preview", {
        method: "POST",
        body: {
          personLabel: name,
          regionLabel: region || undefined,
          walletAddress: state.walletAddress || undefined
        }
      });
      setAnimatedStatus(preStatus, "", false);
      deps.addChat("agent", "Scanning broker indexes and ranking likely matches…");
      deps.render(PANELS.agentChat);
      const quotaNote =
        result.dailyLimit > 0 ? ` ${result.remainingPreviews ?? 0} free preview(s) left today.` : "";
      const candidates = (result.candidates || []).filter((item) => item.matchScore !== "unlikely");
      const statsNote = deps.previewStatsMessage(result.stats, candidates.length, region);
      const message = candidates.length
        ? `Preview found ${candidates.length} possible listing(s).${quotaNote}${statsNote ? ` ${statsNote}` : ""}`
        : `No broker hits in preview.${quotaNote || " Continue to start full cleanup."}${statsNote ? ` ${statsNote}` : ""}`;
      if (candidates.length) {
        deps.addChat("agent", `Found ${candidates.length} possible listing(s). Streaming matches below…`);
        if (statsNote) deps.addChat("agent", statsNote);
        deps.render(PANELS.agentChat);
        await deps.streamBrokerPreviewResults(candidates, message);
      } else {
        deps.renderBrokerPreviewResults(candidates, message);
        deps.addChat("agent", statsNote || "No broker hits in this preview. You can still start full cleanup below.");
        deps.render(PANELS.agentChat);
      }
      state.onboardingPreviewReady = true;
      state.onboardingPreviewUrls = candidates.map((item) => item.sourceUrl).filter(Boolean);
      deps.addChat("agent", "Listings preview complete. Finish the form below and buy credits to start cleanup.");
      deps.render();
      $("#onboarding-intake-full")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      setAnimatedStatus(preStatus, error?.message || "Preview unavailable. Try again.", false);
      deps.addChat("agent", error?.message || "Preview unavailable. Try again.");
      deps.render(PANELS.agentChat);
      deps.write(error);
    } finally {
      state.onboardingPreviewBusy = false;
      if (btn) btn.disabled = false;
      if (preStatus?.classList.contains("status-ellipsis-active")) {
        setAnimatedStatus(preStatus, "", false);
      }
      deps.updateLandingSendState();
      deps.render(PANELS.onboardingSteps);
    }
  }

  async function runPreliminarySearch(parsed) {
    deps.assertCaseActivatedClient();
    const statusEl = $("#simple-start-status");
    const preStatus = $("#pre-search-status");
    if (statusEl) statusEl.textContent = "Searching for exposure…";
    if (preStatus) preStatus.textContent = "Searching…";
    $("#pre-search-panel")?.removeAttribute("hidden");
    await refreshIntegrationsStatus().catch(() => {});
    await deps.startPreset({ quiet: true });
    if (parsed.pastedUrls?.length) {
      if ($("#findings-paste-input")) {
        $("#findings-paste-input").value = parsed.pastedUrls.join("\n");
      }
      localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(parsed.pastedUrls));
    }
    const discovery = await deps.maybeAutoDiscoverFindings({ force: true, quiet: true });
    await syncCurrentCaseStatus();
    const findings = state.currentStatus?.findings || [];
    const searchReady = deps.discoverySearchReady();
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
    deps.addChat("agent", message);
    deps.render();
  }

  async function continueAfterPreSearch() {
    deps.assertCaseActivatedClient();
    const statusEl = $("#simple-start-status");
    if (statusEl) statusEl.textContent = "Starting cleanup…";
    state.preSearchReady = false;
    state.autopilotBusy = true;
    deps.render();
    try {
      await agentAutopilotFlow(state, { silentUser: true }, deps.agentDeps).catch(() => {});
      deps.addChat("agent", `Running ${presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
      resetPreSearchUi();
      if (statusEl) statusEl.textContent = "";
      $("#dashboard-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } finally {
      state.autopilotBusy = false;
      deps.render();
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
        await connectWalletFlow(state, { openHub: false }, deps.walletDeps);
      }
      if (statusEl) statusEl.textContent = "Creating case…";
      await createCaseFlow(
        state,
        {
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
          previewUrls: state.onboardingPreviewUrls ?? [],
          autoStartRoute: true
        },
        deps.casesDeps
      );
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
      deps.write(error);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function startWithAgent() {
    await startSimpleCleanup();
  }

  async function startPreset(options = {}) {
    if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
    deps.assertCaseActivatedClient({ quiet: options.quiet });
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
    await deps.refreshAgentPlan({ silent: true });
    await deps.refreshHackathon({ silent: true, scope: "agent" }).catch(() => {});
    if (!options.quiet) deps.addChat("agent", `${presentPreset(result.preset).title} is staged. I can run the route now.`);
    deps.render();
    deps.write(result);
  }

  function setupLandingLocationCombobox() {
    setupLocationCombobox({
      input: $("#landing-location"),
      menu: $("#landing-location-menu"),
      toggle: $("#landing-location-toggle"),
      field: $("#landing-location-field"),
      onEnter: () => startFromLanding().catch(deps.write)
    });
  }

  function setupOnboardingRegionCombobox() {
    setupLocationCombobox({
      input: $("#simple-region"),
      menu: $("#onboarding-region-menu"),
      toggle: $("#onboarding-region-toggle"),
      field: $("#onboarding-region-field"),
      onEnter: () => runOnboardingPreview().catch(deps.write)
    });
  }

  return {
    isHackathonMode,
    setupLocationCombobox,
    setupLandingLocationCombobox,
    setupOnboardingRegionCombobox,
    isOnboardingWithoutCase,
    filterDefaultWelcomeChat,
    onboardingChatTranscript,
    skillInstallAgentPrompt,
    setupLandingSkillInstall,
    copySkillInstallCommand,
    setSkillInstallTab,
    fillAgentInput,
    applyAdvancedUiVisibility,
    pulseFocusField,
    focusIntake,
    syncSimpleFormToLegacyFields,
    resetPreSearchUi,
    renderPreSearchPreview,
    openNewCaseFlow,
    startFromLanding,
    applyAgentIntakeTemplate,
    runOnboardingPreview,
    runPreliminarySearch,
    continueAfterPreSearch,
    startSimpleCleanup,
    startWithAgent,
    startPreset
  };
}