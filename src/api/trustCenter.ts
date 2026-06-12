import { readFile } from "node:fs/promises";
import type { TrustCenterConfig } from "../domain/attestation.js";

export async function loadTrustCenterConfigFromPath(trustCenterPath: string): Promise<TrustCenterConfig> {
  const config = JSON.parse(await readFile(trustCenterPath, "utf8")) as TrustCenterConfig;
  return {
    ...config,
    attestationReportUrl: process.env.PHALA_ATTESTATION_URL ?? config.attestationReportUrl ?? null,
    phalaVerifierEndpoint: process.env.PHALA_VERIFIER_ENDPOINT ?? config.phalaVerifierEndpoint ?? null,
    maxAttestationAgeSeconds: Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? config.maxAttestationAgeSeconds ?? 600)
  };
}