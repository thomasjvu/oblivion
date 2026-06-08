export function redactedScopeFromIntake(parsed) {
  const labels = [];
  if (parsed.legalName) labels.push("legal-name");
  if (parsed.email || parsed.contactEmail) labels.push("email");
  if (parsed.cityState) labels.push("city-state");
  if (parsed.address) labels.push("address");
  if (parsed.relative) labels.push("relative");
  const personLabel = parsed.legalName
    ? `${String(parsed.legalName).trim().split(/\s+/).map((part) => part[0]).join(".")}.`
    : "User";
  return {
    personLabel,
    aliases: parsed.aliases ?? [],
    approvedIdentifierLabels: labels.length ? labels : ["email"],
    sensitiveConstraints: parsed.sensitiveConstraints ?? []
  };
}

export async function buildEncryptedIntake(vaultKey, caseId, intake, encryptVaultPayload) {
  const encryptedIntake = await encryptVaultPayload(vaultKey, intake, caseId);
  return {
    encryptedIntake,
    redactedScope: redactedScopeFromIntake(intake)
  };
}