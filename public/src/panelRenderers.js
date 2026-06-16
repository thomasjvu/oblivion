import { PANELS } from './renderScheduler.js';
import { agentPfpForTheme } from './theme.js';
import { bindIcons, iconEl, setButtonLabel, setIcon } from './icons.js';
import { isLiveX402Ready } from './x402Gate.js';
import { playCharBeep, stopAgentVoice } from './agentVnTts.js';
import {
  hasEntitledPayment as hasEntitledPaymentForState,
  hasSubscriptionEntitlement as hasSubscriptionEntitlementForState,
  caseIsActivated as caseIsActivatedForState
} from './paymentsFlow.js';
import { isHackathonMode as isHackathonModeForState } from './refresh.js';

export function bindPanelRenderers(deps) {
  const {
    state,
    $,
    escapeHtml,
    displayPlainText,
    pillClass,
    chipClass,
    yesNo,
    walletErrorMarkup,
    isUserRejectedError,
    setInlineStatus,
    shortenAddress,
    renderWalletDebugLog,
    currentCase,
    GUIDE_STEPS,
    WORKFLOW_PHASES,
    currentGuideStep,
    workflowStatusLine,
    renderCleanupProgress,
    syncRouteTabVisibility,
    guidePrimaryLabel,
    runtimeLabel,
    presentPreset,
    presetTitle,
    selectedPreset,
    renderDiscoveryPlan,
    brokerSubmissionBadge,
    matchScorePill,
    shortenUrl,
    isOnboardingWithoutCase,
    onboardingChatTranscript,
    AGENT_INTAKE_TEMPLATES,
    onboardingPresetId,
    selectPresetId,
    isLiveExecutorMode,
    executeActionLabel,
    fillAgentInput,
    applyAdvancedUiVisibility,
    caseDeleteLabel,
    chatMessageSeqRef,
    chatTypewriterTimersRef,
    renderUserGuide,
    renderIntakeInferencePreview
  } = deps;

  let chatMessageSeq = chatMessageSeqRef.value;
  let chatTypewriterTimers = chatTypewriterTimersRef.value;

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
    const activated = caseIsActivatedForState(state);
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
  
  function renderAppearanceSettings() {
    document.querySelectorAll(".theme-toggle-btn[data-theme-choice]").forEach((btn) => {
      const active = btn.dataset.themeChoice === state.themeId;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.setAttribute("aria-checked", active ? "true" : "false");
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
    const avatar = `<span class="chat-avatar chat-avatar-agent" title="Agent" aria-label="Agent"><img src="${agentPfpForTheme(state.themeId)}" alt="" width="36" height="36" /></span>`;
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
    if (!isHackathonMode()) {
      target.innerHTML = "";
      target.hidden = true;
      return;
    }
    target.hidden = false;
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
      ? state.appOpen && (!caseIsActivatedForState(state) || state.preSearchReady)
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

  function renderSubscriptionUpsell() {
    const banner = $("#subscription-upsell");
    if (!banner) return;
    const show =
      Boolean(state.currentCaseId && state.currentStatus) &&
      (state.aiEntitlement?.mode === "one-off" || hasEntitledPaymentForState(state, "one-off")) &&
      !hasSubscriptionEntitlementForState(state) &&
      !isUpsellDismissed(state.currentCaseId);
    banner.hidden = !show;
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

  function panelRenderers() {
    return {
      [PANELS.trust]: renderTrust,
      [PANELS.cases]: renderCases,
      [PANELS.shell]: renderShell,
      [PANELS.userGuide]: renderUserGuide,
      [PANELS.walletCommandStrip]: renderWalletCommandStrip,
      [PANELS.intakeInferencePreview]: renderIntakeInferencePreview,
      [PANELS.dashboard]: renderDashboard,
      [PANELS.onboardingSteps]: renderOnboardingSteps,
      [PANELS.onboardingPayment]: renderOnboardingPayment,
      [PANELS.subscriptionUpsell]: renderSubscriptionUpsell,
      [PANELS.findings]: renderFindings,
      [PANELS.presets]: renderPresets,
      [PANELS.agentChat]: renderAgentChat,
      [PANELS.hackathonChecklist]: renderHackathonChecklist,
      [PANELS.appearanceSettings]: renderAppearanceSettings,
      [PANELS.privacyFilterSettings]: renderPrivacyFilterSettings,
      [PANELS.agentVoiceSettings]: renderAgentVoiceSettings,
      [PANELS.payments]: renderPayments,
      [PANELS.agentNetwork]: renderAgentNetwork,
      [PANELS.relayer]: renderRelayer,
      [PANELS.approvals]: renderApprovals,
      [PANELS.actions]: renderActions,
      [PANELS.vaultPanel]: renderVaultPanel,
      [PANELS.tabs]: renderTabs
    };
  }

  chatMessageSeqRef.value = chatMessageSeq;
  chatTypewriterTimersRef.value = chatTypewriterTimers;

  return {
    panelRenderers,
    renderTrust,
    renderCases,
    renderShell,
    renderWalletCommandStrip,
    renderWalletModal,
    renderWalletFeedback,
    renderWalletPanels,
    renderDashboard,
    renderOnboardingSteps,
    renderOnboardingPayment,
    renderSubscriptionUpsell,
    renderFindings,
    renderPresets,
    renderAgentChat,
    renderHackathonChecklist,
    renderAppearanceSettings,
    renderPrivacyFilterSettings,
    renderAgentVoiceSettings,
    renderPayments,
    renderAgentNetwork,
    renderRelayer,
    renderApprovals,
    renderActions,
    renderVaultPanel,
    renderTabs,
    addChat,
    cancelChatTypewriters,
    runChatTypewriters,
    renderChatBubble,
    agentPromptForState,
    shortStepTitle,
    hackathonPendingTracks,
    walletButtonLabel,
    walletButtonTitle,
    toggleWalletModal,
    openPaymentRails,
    openWalletHub,
    formatProductPrice,
    dismissSubscriptionUpsell,
    selectPaymentMode,
    syncPaymentPlanFromForm,
    productBudgetLine,
    formatCaseDate,
    titleForAction
  };
}
