export function isHackathonMode(state) {
  return Boolean(state.integrationsStatus?.hackathonMode);
}

export async function refreshCreditsBalance(state, request) {
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

export async function refreshProducts(state, request) {
  const products = await request("/api/x402/products");
  state.products = products.products || [];
  state.creditRates = products.credits || null;
  await refreshCreditsBalance(state, request).catch(() => {});
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
  return products;
}

export async function refreshAgentContext(state, request) {
  if (!state.currentCaseId) {
    state.hackathon = null;
    state.agentNext = null;
    return { timeline: null, next: null };
  }
  const [timeline, next] = await Promise.all([
    request(`/api/agents/timeline?caseId=${state.currentCaseId}`),
    request(`/api/agent/next?caseId=${state.currentCaseId}`)
  ]);
  state.hackathon = timeline;
  state.agentNext = next;
  return { timeline, next };
}

export async function refreshHackathonChecklist(state, request) {
  if (!isHackathonMode(state) || !state.currentCaseId) {
    state.hackathonStatus = null;
    state.hackathonPending = [];
    return null;
  }
  const checklist = await request(`/api/hackathon/status?caseId=${state.currentCaseId}`);
  state.hackathonStatus = checklist.status;
  state.hackathonPending = checklist.pending || [];
  return checklist;
}

export async function refreshHackathon(state, request, options = {}) {
  const scope = options.scope || "all";
  let products = null;
  let timeline = null;
  let checklist = null;

  if (scope === "all" || scope === "products") {
    products = await refreshProducts(state, request);
  }

  if (scope === "all" || scope === "agent") {
    if (!state.currentCaseId) {
      state.hackathon = null;
      state.hackathonStatus = null;
      if (!options.silent && options.onWrite) options.onWrite(scope === "products" ? { products } : { products, timeline: null });
      return;
    }
    const ctx = await refreshAgentContext(state, request);
    timeline = ctx.timeline;
  }

  if (scope === "all" || scope === "checklist") {
    if (!state.currentCaseId) return;
    if (isHackathonMode(state)) {
      checklist = await refreshHackathonChecklist(state, request);
      if (!options.silent && options.onWrite) {
        options.onWrite(
          scope === "all" ? { products, timeline, checklist } : { checklist }
        );
      }
      return;
    }
    state.hackathonStatus = null;
    state.hackathonPending = [];
  }

  if (!options.silent && options.onWrite) {
    if (scope === "all") options.onWrite({ products, timeline });
    else if (scope === "agent") options.onWrite({ timeline });
    else if (scope === "products") options.onWrite({ products });
  }
}