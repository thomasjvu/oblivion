export type TrustPrivacyAudience = "consumer" | "partner";

type TrustPrivacyBase = {
  storedPlaintext: false;
  serverCanDecryptCaseVault: false;
  rawPiiToNonTeeLlm: false;
  defaultExecutor: "record-only";
  sensitiveActionRequiresApproval: true;
  thirdPartyDisclosureStillPossible: true;
};

export type ConsumerTrustPrivacyResponse = TrustPrivacyBase & {
  message: string;
};

export type PartnerTrustPrivacyResponse = TrustPrivacyBase & {
  partnerCanDecryptCaseVault: false;
  partnerIntegrationModel: string;
  message: string;
};

export function buildTrustPrivacyResponse(audience: "partner"): PartnerTrustPrivacyResponse;
export function buildTrustPrivacyResponse(audience: "consumer"): ConsumerTrustPrivacyResponse;
export function buildTrustPrivacyResponse(audience: TrustPrivacyAudience): ConsumerTrustPrivacyResponse | PartnerTrustPrivacyResponse;
export function buildTrustPrivacyResponse(audience: TrustPrivacyAudience) {
  const base = {
    storedPlaintext: false,
    serverCanDecryptCaseVault: false,
    rawPiiToNonTeeLlm: false,
    defaultExecutor: "record-only",
    sensitiveActionRequiresApproval: true,
    thirdPartyDisclosureStillPossible: true
  };
  if (audience === "partner") {
    return {
      ...base,
      partnerCanDecryptCaseVault: false,
      partnerIntegrationModel:
        "Partners receive redacted metadata and lifecycle webhooks. Plaintext stays in the user browser vault until explicit per-action approval.",
      message:
        "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties. Partners must not request vault decryption."
    };
  }
  return {
    ...base,
    message:
      "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties, and sensitive plaintext should only be decrypted in the browser or an attested TEE task."
  };
}