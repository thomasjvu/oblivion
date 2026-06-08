import type { TrustCenterConfig } from "./attestation.js";
import { buildAttestationProof } from "./attestation.js";
import { runtimeModeFromProof } from "./runtimeGuard.js";

export async function buildPartnerRuntimeBadge(
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>,
  fetchLive = true
) {
  const proof = await buildAttestationProof(await loadTrustCenterConfig(), { fetchLive });
  const runtimeMode = runtimeModeFromProof(proof);
  return {
    runtimeMode,
    verifierResult: proof.verifierResult,
    attestationFresh: proof.attestationFresh,
    composeHashMatches: proof.composeHashMatches,
    hardwareQuoteVerified: proof.hardwareQuoteVerified,
    trustSummary: proof.trustSummary,
    liveExecutionAvailable: proof.verifierResult === "pass"
  };
}