import { redactedScopeFromIntake as domainRedactedScopeFromIntake } from "../../src/domain/intakeScope.ts";

export function redactedScopeFromIntake(parsed) {
  return domainRedactedScopeFromIntake({
    legalName: parsed.personLabel,
    aliases: parsed.aliases,
    cityState: parsed.region,
    sensitiveConstraints: parsed.region ? [parsed.region] : []
  });
}

export { domainRedactedScopeFromIntake };