import { DomainError } from "./errors.js";
import { detectForbiddenSecrets, redactText } from "./redaction.js";
import type { RedactedScope } from "./types.js";

export interface DiscoverySearchLabels {
  personLabel: string;
  aliases?: string[];
  regionLabel?: string;
}

export type BrokerSweepScope = {
  personLabel?: string;
  aliases?: string[];
  regionLabel?: string;
};

const CATEGORY_LABELS = new Set(["legal-name", "email", "city-state", "address", "relative", "phone"]);

function looksLikeLocation(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (/^no\s+/i.test(trimmed) || /^do not/i.test(trimmed)) return false;
  if (CATEGORY_LABELS.has(trimmed.toLowerCase())) return false;
  return /[a-z]/i.test(trimmed);
}

export function validateDiscoverySearchLabels(
  input: DiscoverySearchLabels | undefined
): DiscoverySearchLabels | undefined {
  if (!input) return undefined;
  const personLabel = input.personLabel?.trim();
  if (!personLabel) return undefined;
  if (detectForbiddenSecrets(personLabel).length > 0) {
    throw new DomainError("search-label-forbidden", 422);
  }
  const aliases = (input.aliases ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (detectForbiddenSecrets(item).length > 0) {
        throw new DomainError("search-label-forbidden", 422);
      }
      return redactText(item);
    });
  const regionRaw = input.regionLabel?.trim();
  if (regionRaw && detectForbiddenSecrets(regionRaw).length > 0) {
    throw new DomainError("search-label-forbidden", 422);
  }
  return {
    personLabel: redactText(personLabel),
    aliases,
    regionLabel: regionRaw ? redactText(regionRaw) : undefined
  };
}

export function regionLabelFromScope(scope?: RedactedScope): string | undefined {
  if (!scope) return undefined;
  for (const item of scope.sensitiveConstraints ?? []) {
    const trimmed = item?.trim();
    if (trimmed && looksLikeLocation(trimmed)) return redactText(trimmed);
  }
  for (const item of scope.approvedIdentifierLabels ?? []) {
    const trimmed = item?.trim();
    if (trimmed && looksLikeLocation(trimmed)) return redactText(trimmed);
  }
  return undefined;
}

export function resolveBrokerSweepScope(
  scope?: RedactedScope,
  searchLabels?: DiscoverySearchLabels
): BrokerSweepScope | undefined {
  if (searchLabels?.personLabel?.trim()) {
    return {
      personLabel: searchLabels.personLabel.trim(),
      aliases: searchLabels.aliases ?? [],
      regionLabel: searchLabels.regionLabel?.trim() || regionLabelFromScope(scope)
    };
  }
  if (!scope?.personLabel?.trim()) return undefined;
  return {
    personLabel: scope.personLabel.trim(),
    aliases: scope.aliases ?? [],
    regionLabel: regionLabelFromScope(scope)
  };
}

export function resolveBraveSearchScope(
  scope?: RedactedScope,
  searchLabels?: DiscoverySearchLabels
): RedactedScope | undefined {
  if (searchLabels?.personLabel?.trim()) {
    const region = searchLabels.regionLabel?.trim() || regionLabelFromScope(scope);
    return {
      personLabel: searchLabels.personLabel.trim(),
      aliases: searchLabels.aliases ?? [],
      approvedIdentifierLabels: region ? [region] : [],
      sensitiveConstraints: region ? [region] : scope?.sensitiveConstraints ?? []
    };
  }
  return scope;
}

export function discoverySearchMode(
  scope?: RedactedScope,
  searchLabels?: DiscoverySearchLabels
): "ephemeral" | "redacted" {
  return searchLabels?.personLabel?.trim() ? "ephemeral" : "redacted";
}

export function discoverySearchNameLabel(
  scope?: RedactedScope,
  searchLabels?: DiscoverySearchLabels
): string {
  const sweep = resolveBrokerSweepScope(scope, searchLabels);
  const candidates = [sweep?.personLabel, ...(sweep?.aliases ?? [])]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  if (!candidates.length) return scope?.personLabel?.trim() || "";
  return candidates.sort(
    (left, right) =>
      right.split(/\s+/).length - left.split(/\s+/).length || right.length - left.length
  )[0];
}