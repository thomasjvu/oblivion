import type { TrustCenterConfig } from "../../domain/attestation.js";
import { buildAttestationProof } from "../../domain/attestation.js";
import { buildPartnerRuntimeBadge } from "../../domain/partnerRuntime.js";
import { buildTrustPrivacyResponse } from "../../domain/trustPrivacy.js";
import type { TrustPrivacyAudience } from "../../domain/trustPrivacy.js";

export async function handleTrustAttestation(
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>,
  fetchLive: boolean
) {
  const config = await loadTrustCenterConfig();
  return buildAttestationProof(config, { fetchLive });
}

export async function handlePartnerRuntimeBadge(
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>,
  fetchLive: boolean
) {
  return buildPartnerRuntimeBadge(loadTrustCenterConfig, fetchLive);
}

export function handleTrustPrivacy(audience: TrustPrivacyAudience) {
  return buildTrustPrivacyResponse(audience);
}