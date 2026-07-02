export const SIMPLE_PRESET_DEFAULTS = {
  "people-search-cleanup": { jurisdiction: "US", riskLevel: "standard" },
  "search-result-suppression": { jurisdiction: "US", riskLevel: "standard" },
  "california-drop": { jurisdiction: "US", riskLevel: "standard" },
  "gdpr-erasure": { jurisdiction: "EU", riskLevel: "standard" },
  "breach-exposure": { jurisdiction: "US", riskLevel: "standard" },
  "high-risk-safety": { jurisdiction: "US", riskLevel: "high-risk-safety" },
  "content-takedown": { jurisdiction: "US", riskLevel: "standard" }
};

export const AGENT_INTAKE_TEMPLATES = {
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

export function bindIntakeFlow(deps) {
  const { state, $, isOnboardingWithoutCase } = deps;

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

    const defaults = SIMPLE_PRESET_DEFAULTS[state.selectedPresetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
    const jurisdiction = $("#jurisdiction");
    const risk = $("#risk-level");
    if (jurisdiction) jurisdiction.value = defaults.jurisdiction;
    if (risk) risk.value = defaults.riskLevel;
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

  function presetTitle(presetId) {
    const preset = state.presets.find((item) => item.id === presetId);
    return preset ? presentPreset(preset).title : "";
  }

  return {
    onboardingPresetId,
    syncJurisdictionFromRegionLabel,
    readSimpleIntakeForm,
    intakeTextForPreset,
    selectPresetId,
    presentPreset,
    parseIntakeForCase,
    personLabelFromIntake,
    urlsFromText,
    pastedUrlsFromFindingsInput,
    applyParsedIntakeToForm,
    renderIntakeInferencePreview,
    recommendPreset,
    selectedPreset,
    presetTitle
  };
}
