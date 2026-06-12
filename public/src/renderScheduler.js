export const PANELS = {
  trust: "trust",
  cases: "cases",
  shell: "shell",
  userGuide: "userGuide",
  walletCommandStrip: "walletCommandStrip",
  intakeInferencePreview: "intakeInferencePreview",
  dashboard: "dashboard",
  onboardingSteps: "onboardingSteps",
  onboardingPayment: "onboardingPayment",
  subscriptionUpsell: "subscriptionUpsell",
  findings: "findings",
  presets: "presets",
  agentChat: "agentChat",
  hackathonChecklist: "hackathonChecklist",
  privacyFilterSettings: "privacyFilterSettings",
  agentVoiceSettings: "agentVoiceSettings",
  payments: "payments",
  agentNetwork: "agentNetwork",
  relayer: "relayer",
  approvals: "approvals",
  actions: "actions",
  vaultPanel: "vaultPanel",
  tabs: "tabs"
};

const dirty = new Set();

export function invalidate(...panels) {
  if (!panels.length) {
    for (const panel of Object.values(PANELS)) dirty.add(panel);
    return;
  }
  for (const panel of panels) dirty.add(panel);
}

export function renderIfDirty(renderers) {
  for (const [panel, render] of Object.entries(renderers)) {
    if (dirty.has(panel)) {
      render();
      dirty.delete(panel);
    }
  }
}

export function renderAll(renderers, afterRender) {
  invalidate(...Object.values(PANELS));
  renderIfDirty(renderers);
  afterRender?.();
}