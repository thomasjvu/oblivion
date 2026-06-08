import { redactedScopeFromIntake } from "../../src/domain/intakeScope.ts";

export { redactedScopeFromIntake };

export async function buildEncryptedIntake(vaultKey, caseId, intake, encryptVaultPayload) {
  const encryptedIntake = await encryptVaultPayload(vaultKey, intake, caseId);
  return {
    encryptedIntake,
    redactedScope: redactedScopeFromIntake(intake)
  };
}