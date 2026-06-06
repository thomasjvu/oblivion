export interface SourceVerificationRecord {
  connectorId: string;
  officialUrl: string;
  checkedAt: string;
  claimVerified: string;
  expectedRemovalPath: string;
  operatorVersion: string;
}

export const SOURCE_VERIFICATION_REGISTRY: SourceVerificationRecord[] = [
  {
    connectorId: "google-removal-plan",
    officialUrl: "https://support.google.com/websearch/answer/12719076",
    checkedAt: "2026-06-02",
    claimVerified: "Google Results about you and search-result removal guidance must remain a user-handoff flow.",
    expectedRemovalPath: "Draft source deletion first, then guide the user to Google's official suppression path.",
    operatorVersion: "oblivion-source-registry-v1"
  },
  {
    connectorId: "hibp-email",
    officialUrl: "https://haveibeenpwned.com/API/v3",
    checkedAt: "2026-06-02",
    claimVerified: "HIBP email breach checks require explicit approval and configured API access.",
    expectedRemovalPath: "Mitigation only; do not search breach dumps or promise data deletion.",
    operatorVersion: "oblivion-source-registry-v1"
  },
  {
    connectorId: "hibp-password-range",
    officialUrl: "https://haveibeenpwned.com/API/v3#PwnedPasswords",
    checkedAt: "2026-06-02",
    claimVerified: "Pwned Passwords range checks transmit only a SHA-1 prefix, never a full password.",
    expectedRemovalPath: "Return mitigation guidance and never store or transmit the password.",
    operatorVersion: "oblivion-source-registry-v1"
  },
  {
    connectorId: "california-drop-guided",
    officialUrl: "https://privacy.ca.gov/drop/",
    checkedAt: "2026-06-02",
    claimVerified: "California DROP is an official resident flow with broker processing timing tracked separately.",
    expectedRemovalPath: "User-held official submission plus follow-up scheduling.",
    operatorVersion: "oblivion-source-registry-v1"
  },
  {
    connectorId: "people-search-guidance",
    officialUrl: "https://www.consumer.ftc.gov/articles/what-know-about-people-search-sites",
    checkedAt: "2026-06-04",
    claimVerified: "People-search cleanup must use official consumer guidance and broker-specific opt-out paths after user confirmation.",
    expectedRemovalPath: "Identify broker, verify opt-out URL, draft removal, and schedule recheck.",
    operatorVersion: "oblivion-source-registry-v1"
  },
  {
    connectorId: "gdpr-template",
    officialUrl: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/",
    checkedAt: "2026-06-02",
    claimVerified: "UK/GDPR erasure rights are not absolute and may require controller-specific review.",
    expectedRemovalPath: "Draft controller request, track response window, and prepare escalation notes.",
    operatorVersion: "oblivion-source-registry-v1"
  }
];

export function sourceVerificationFor(connectorId: string): SourceVerificationRecord | undefined {
  return SOURCE_VERIFICATION_REGISTRY.find((record) => record.connectorId === connectorId);
}

