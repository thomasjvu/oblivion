import { DomainError } from "./errors.js";
import type { AttestationProof } from "./types.js";

export type RuntimeMode = "local" | "tee-verified" | "tee-blocked";

export function runtimeModeFromProof(proof: Pick<AttestationProof, "verifierResult">): RuntimeMode {
  if (proof.verifierResult === "pass") return "tee-verified";
  if (proof.verifierResult === "fail") return "tee-blocked";
  return "local";
}

export function assertSensitiveExecutionAllowed(input: {
  proof: Pick<AttestationProof, "verifierResult">;
  requiresManagedPlaintext: boolean;
  localSafe: boolean;
}): void {
  if (!input.requiresManagedPlaintext || input.localSafe) return;
  if (runtimeModeFromProof(input.proof) === "tee-verified") return;
  throw new DomainError("runtime-not-tee-verified", 403);
}

