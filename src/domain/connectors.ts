import type { ActionType, ConnectorResult, IdentifierCategory } from "./types.js";
import { sourceVerificationFor } from "./sourceVerification.js";

export type ConnectorCapability =
  | "exposure-discovery"
  | "removal-drafting"
  | "breach-mitigation"
  | "official-handoff"
  | "recheck-scheduling";

export interface ConnectorApprovalRequirement {
  actionType: ActionType;
  dataToDisclose: IdentifierCategory[];
  exactDestinationRequired: boolean;
}

export interface ConnectorRunInput {
  caseId: string;
  approvalId?: string;
  redactedPayload: Record<string, unknown>;
  now?: Date;
}

export interface ConnectorRunResult {
  result: ConnectorResult;
  transmitted: string[];
  neverTransmit: string[];
}

export interface Connector {
  id: string;
  capabilities: ConnectorCapability[];
  requiredApproval?: ConnectorApprovalRequirement;
  requiresManagedPlaintext: boolean;
  requiresUserHandoff: boolean;
  redactionPolicy: string[];
  run?: (input: ConnectorRunInput) => Promise<ConnectorRunResult>;
}

export const CONNECTOR_REGISTRY: Connector[] = [
  {
    id: "people-search-guidance",
    capabilities: ["exposure-discovery", "removal-drafting", "recheck-scheduling"],
    requiredApproval: {
      actionType: "broker-opt-out",
      dataToDisclose: ["legal-name", "email"],
      exactDestinationRequired: true
    },
    requiresManagedPlaintext: false,
    requiresUserHandoff: false,
    redactionPolicy: ["timeline stores source URL and data categories only", "no raw identifiers in connector result"]
  },
  {
    id: "google-removal-plan",
    capabilities: ["removal-drafting", "official-handoff"],
    requiredApproval: {
      actionType: "search-result-removal",
      dataToDisclose: ["legal-name", "email"],
      exactDestinationRequired: true
    },
    requiresManagedPlaintext: false,
    requiresUserHandoff: true,
    redactionPolicy: ["separate source deletion from search suppression", "guide official flow instead of logged-in automation"]
  },
  {
    id: "hibp-password-range",
    capabilities: ["breach-mitigation"],
    requiredApproval: {
      actionType: "pwned-password-range-check",
      dataToDisclose: [],
      exactDestinationRequired: false
    },
    requiresManagedPlaintext: false,
    requiresUserHandoff: false,
    redactionPolicy: ["accept SHA-1 prefix only", "never accept or transmit full passwords"]
  },
  {
    id: "hibp-email",
    capabilities: ["breach-mitigation"],
    requiredApproval: {
      actionType: "hibp-email-check",
      dataToDisclose: ["email"],
      exactDestinationRequired: true
    },
    requiresManagedPlaintext: true,
    requiresUserHandoff: false,
    redactionPolicy: ["build outbound email query from an approval record", "block in non-TEE managed runtime"]
  },
  {
    id: "california-drop-guided",
    capabilities: ["official-handoff", "recheck-scheduling"],
    requiredApproval: {
      actionType: "follow-up",
      dataToDisclose: ["legal-name", "email", "address"],
      exactDestinationRequired: true
    },
    requiresManagedPlaintext: false,
    requiresUserHandoff: true,
    redactionPolicy: ["confirm California eligibility", "keep official submission user-held"]
  },
  {
    id: "gdpr-template",
    capabilities: ["removal-drafting", "official-handoff"],
    requiredApproval: {
      actionType: "gdpr-erasure",
      dataToDisclose: ["legal-name", "email"],
      exactDestinationRequired: true
    },
    requiresManagedPlaintext: false,
    requiresUserHandoff: true,
    redactionPolicy: ["draft request text only", "track controller response window"]
  }
];

export function connectorById(connectorId: string): Connector | undefined {
  return CONNECTOR_REGISTRY.find((connector) => connector.id === connectorId);
}

export function connectorHasVerifiedSource(connectorId: string): boolean {
  return Boolean(sourceVerificationFor(connectorId));
}

