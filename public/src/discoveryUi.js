import { setButtonLabel } from './icons.js';
import { searchLabelsForDiscover } from './discoverySearchLabels.js';

export function bindDiscoveryUi(deps) {
  const {
    state,
    $,
    escapeHtml,
    pulseFocusField,
    currentGuideStep,
    urlsFromText,
    pastedUrlsFromFindingsInput: pastedUrlsFromFindingsInputFn,
    request,
    addChat,
    write,
    render,
    refreshAgentPlan,
    refreshHackathon,
    refreshIntegrationsStatus,
    assertCaseActivatedClient,
    syncCurrentCaseStatus
  } = deps;

  function discoveryUrlHints() {
    const fromPaste = pastedUrlsFromFindingsInputFn();
    if (fromPaste.length) return fromPaste;
    const fromPreview = (state.onboardingPreviewUrls || []).filter(Boolean);
    if (fromPreview.length) return fromPreview;
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
    const confirmed = state.currentStatus?.confirmedFindings?.length ?? 0;
    return pending === 0 && confirmed === 0;
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
      const searchNote =
        plan.searchMode === "ephemeral"
          ? " Using your name from this device for this search only."
          : plan.searchMode === "redacted" && plan.summary?.includes("redacted label")
            ? " Using stored redacted initials — add name in the form for better matches."
            : "";
      const readinessNote = !discoverySearchReady()
        ? " Automated web search is off on the server — profile URL patterns and pasted links still work."
        : "";
      statusEl.textContent = state.discoveryBusy
        ? "Running broker sweep and web search…"
        : !plan.canAutoDiscover
          ? `Add profile URLs below, then tap Discover listings.${readinessNote}`
          : `${searchNote}${readinessNote}`.trim();
    }
  }
  
  function openFindingsPastePanel() {
    const details = $("#findings-paste-details");
    if (details && !details.open) details.open = true;
    pulseFocusField($("#findings-paste-input"));
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
  
  function discoverySearchReady() {
    const live = state.integrationsStatus?.liveReady;
    return Boolean(live?.veniceSearch || live?.braveSearch);
  }
  
  async function maybeAutoDiscoverFindings(options = {}) {
    if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
    if (!options.force && (!peopleSearchPresetActive() || !needsExposureDiscovery())) {
      return { ran: false, reason: "not-needed" };
    }
    const pastedUrls =
      options.pastedUrls === undefined ? discoveryUrlHints() : options.pastedUrls;
    const searchReady = discoverySearchReady();
    const searchLabels = options.searchLabels ?? (await searchLabelsForDiscover(state, $));
    const profileSlugReady = Boolean(searchLabels?.personLabel);
    if (
      !options.force &&
      !pastedUrls.length &&
      !searchReady &&
      !profileSlugReady
    ) {
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
          searchLabels,
          walletAddress: state.walletAddress || undefined
        }
      });
      state.discoveryPlan = result.discoveryPlan ?? null;
      state.currentStatus = result.status ?? (await request(`/api/cases/${state.currentCaseId}`)).status;
      if (pastedUrlsFromFindingsInputFn().length && $("#findings-paste-input")) {
        $("#findings-paste-input").value = "";
      }
      if (pastedUrls.length) {
        localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(pastedUrls));
      }
      await refreshAgentPlan({ silent: true }).catch(() => {});
      await refreshHackathon({ silent: true, scope: "agent" }).catch(() => {});
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
        throw {
          error: "urls-required",
          message: "Enter your name on the form, paste a profile URL, or enable Brave search on the server."
        };
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
    }
  }

  return {
    discoveryUrlHints,
    peopleSearchPresetActive,
    brokerSubmissionBadge,
    needsExposureDiscovery,
    renderDiscoveryPlan,
    openFindingsPastePanel,
    matchScorePill,
    shortenUrl,
    discoverySearchReady,
    maybeAutoDiscoverFindings,
    discoverFindings,
    decideFinding,
    brokerPreviewResultMarkup,
    previewStatsMessage,
    renderBrokerPreviewResults,
    streamBrokerPreviewResults
  };
}
