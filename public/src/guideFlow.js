import { bindIcons } from './icons.js';

export const GUIDE_STEPS = [
  { num: 1, title: "Start", hint: "Enter your name and tap Start cleanup.", icon: "play" },
  { num: 2, title: "Review", hint: "Confirm which listings are yours.", icon: "search" },
  { num: 3, title: "Approve", hint: "Approve before anything is sent.", icon: "check" }
];
export const WORKFLOW_PHASES = [
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

export function bindGuideFlow(deps) {
  const { state, $, escapeHtml, yesNo, currentCase, openApp, startSimpleCleanup, render, refreshTrust } = deps;

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
      await deps.agentAutopilot();
      return;
    }
    if (step === 3) {
      state.tab = "overview";
      state.dockOpen = true;
      render();
      return;
    }
    await deps.agentAutopilot();
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
  
  function workflowStatusLine() {
    const pending = state.currentStatus?.pendingFindings?.length || 0;
    const approvals = state.currentStatus?.approvalsNeeded?.length || 0;
    let statusLine = state.agentNext?.message || state.agentPlan?.nextUserDecision || "";
    if (pending > 0) statusLine = `${pending} listing(s) need your answer.`;
    if (approvals > 0) statusLine = "Approval required before anything is sent.";
    if (state.autopilotBusy) statusLine = "Running cleanup…";
    return statusLine;
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

  return {
    currentGuideStep,
    guidePrimaryLabel,
    performGuidePrimaryAction,
    renderUserGuide,
    runtimeLabel,
    teeQuestionIntent,
    buildTeeVerificationBrief,
    workflowStatusLine,
    renderCleanupProgress,
    shouldShowRouteTab,
    revealRouteTab,
    syncRouteTabVisibility
  };
}
