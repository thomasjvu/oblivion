export function isLiveX402Ready(integrationsStatus) {
  return Boolean(integrationsStatus?.liveReady?.x402);
}

export function agentEndpointForMode(mode) {
  return mode === "subscription" ? "/api/credits/monitor" : "/api/credits/purchase";
}

let x402PayModule = null;

async function loadX402Pay() {
  if (!x402PayModule) {
    x402PayModule = await import("./x402Pay.js");
  }
  return x402PayModule;
}

export async function settleAgentPayment(args) {
  const mod = await loadX402Pay();
  return mod.settleAgentPayment(args);
}