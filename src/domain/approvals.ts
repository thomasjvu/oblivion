import { brokerCatalogEntryById, dataToDiscloseForBroker } from "./brokerCatalog.js";
import { defaultActionTypeForPreset, defaultDestinationForPreset, getPreset, presetUsesBrokerDiscovery } from "./cleanup.js";
import { deadlineBasisFor, followUpDate } from "./deadlines.js";
import { buildExecuteHandoff } from "./executeHandoff.js";
import { hostFromDestination, resolveHostAbuseContact } from "./platformAbuse.js";
import { connectorIdForAction } from "./connectorRuntime.js";
import { ACTION_POLICY_MATRIX } from "./policyMatrix.js";
import { evaluateProposedAction } from "./policy.js";
import { sourceVerificationFor } from "./sourceVerification.js";
import { buildDraftText, templateForAction } from "./templates.js";
import type {
  ActionRequest,
  ActionType,
  AgentPlan,
  Approval,
  CaseRecord,
  Exposure,
  IdentifierCategory,
  Jurisdiction,
  PresetId
} from "./types.js";
import { DomainError } from "./errors.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export interface ProposedActionInput {
  caseId: string;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  sourceVerified?: boolean;
  plaintextPreview?: string;
  expectedConfirmationStep?: string;
}

export function createApproval(caseId: string, body: ProposedActionInput): Approval {
  const now = new Date();
  return {
    id: `approval_${crypto.randomUUID()}`,
    caseId,
    actionType: body.actionType,
    destination: body.destination,
    identifiersApproved: body.identifiers ?? [],
    dataToDisclose: body.dataToDisclose ?? [],
    purpose: body.purpose,
    disclosureRisk: "Approved data will be disclosed to the named destination if execution is connected to an external adapter.",
    expiresAt: followUpDate(7, now),
    status: "pending",
    createdAt: now.toISOString()
  };
}

export function createActionRequest(
  jurisdiction: Jurisdiction,
  approvalId: string,
  body: ProposedActionInput
): ActionRequest {
  return {
    id: `action_${crypto.randomUUID()}`,
    caseId: body.caseId,
    actionType: body.actionType,
    destination: body.destination,
    template: templateForAction(body.actionType, jurisdiction),
    draftText: buildDraftText({
      actionType: body.actionType,
      jurisdiction,
      destination: body.destination,
      purpose: body.purpose
    }),
    deadlineBasis: deadlineBasisFor(body.actionType, jurisdiction),
    expectedConfirmationStep: body.expectedConfirmationStep ?? "User confirms the destination and approved data before external submission.",
    approvalId,
    executionStatus: "awaiting-approval",
    createdAt: new Date().toISOString()
  };
}

export function proposeApprovedAction(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  body: ProposedActionInput;
}): { approval: Approval; action: ActionRequest } {
  const policySpec = ACTION_POLICY_MATRIX[input.body.actionType];
  const connectorId = connectorIdForAction(input.body.actionType);
  const sourceVerified = policySpec.requiresSourceVerification
    ? Boolean(sourceVerificationFor(connectorId))
    : true;
  const policy = evaluateProposedAction({
    authorityBasis: input.caseRecord.authorityBasis,
    actionType: input.body.actionType,
    destination: input.body.destination,
    purpose: input.body.purpose,
    identifiers: input.body.identifiers,
    dataToDisclose: input.body.dataToDisclose,
    plaintextPreview: input.body.plaintextPreview,
    sourceVerified,
    hasApproval: false
  });
  if (!policy.allowed) throw new DomainError("policy-blocked", 422, { reasons: policy.reasons });
  const approval = createApproval(input.caseRecord.id, input.body);
  const action = createActionRequest(input.caseRecord.jurisdiction, approval.id, input.body);
  input.store.approvals.set(approval.id, approval);
  input.store.actions.set(action.id, action);
  return { approval, action };
}

export function createPresetApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  if (presetUsesBrokerDiscovery(plan.presetId)) {
    return createBrokerOptOutApprovals(store, caseRecord, plan);
  }
  if (plan.presetId === "content-takedown") {
    return createContentTakedownApprovals(store, caseRecord, plan);
  }
  if (plan.presetId === "breach-exposure") {
    return createBreachExposureApprovals(store, caseRecord);
  }
  return [createPresetApproval(store, caseRecord, plan.presetId)];
}

export function buildExecuteHandoffFromStore(store: MemoryStore, action: ActionRequest) {
  const exposures = store.exposuresForCase(action.caseId);
  return buildExecuteHandoff({
    action: {
      actionType: action.actionType,
      exposureId: action.exposureId,
      destination: action.destination
    },
    status: {
      confirmedFindings: exposures
        .filter((item) => item.matchStatus === "confirmed")
        .map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
      pendingFindings: exposures
        .filter((item) => item.matchStatus === "pending")
        .map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
      findings: exposures.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl }))
    }
  });
}

export function createBreachExposureApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord
): Array<{ approval: Approval; action: ActionRequest }> {
  const emailCheck = createPresetApproval(store, caseRecord, "breach-exposure");
  const passwordBody: ProposedActionInput = {
    caseId: caseRecord.id,
    actionType: "pwned-password-range-check",
    destination: "Have I Been Pwned — Pwned Passwords",
    purpose: "Check approved password exposure using SHA-1 prefix range lookup only.",
    identifiers: [],
    dataToDisclose: [],
    sourceVerified: true,
    expectedConfirmationStep:
      "User supplies password in browser vault only; server receives a 5-character SHA-1 prefix."
  };
  const passwordCheck = proposeApprovedAction({ store, caseRecord, body: passwordBody });
  return [emailCheck, passwordCheck];
}

/** @deprecated use createPresetApprovals */
export function createPresetApproval(store: MemoryStore, caseRecord: CaseRecord, presetId: PresetId): { approval: Approval; action: ActionRequest } {
  const preset = getPreset(presetId);
  const actionType = defaultActionTypeForPreset(presetId, caseRecord.jurisdiction);
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const primaryConfirmed = confirmed[0];
  const destination =
    primaryConfirmed?.brokerLabel || primaryConfirmed?.sourceUrl || defaultDestinationForPreset(presetId);
  const identifiers = preset.requiredIdentifierCategories.filter((category) => category !== "password");
  const dataToDisclose: IdentifierCategory[] = presetId === "breach-exposure" ? ["email"] : identifiers.slice(0, 3);
  const body: ProposedActionInput = {
    caseId: caseRecord.id,
    actionType,
    destination,
    purpose: presetId === "breach-exposure"
      ? "Check approved email exposure through HIBP for mitigation guidance only."
      : preset.summary,
    identifiers,
    dataToDisclose,
    sourceVerified: true,
    expectedConfirmationStep:
      "User reviews destination, data categories, purpose, disclosure risk, and expiration before execution."
  };
  const proposed = proposeApprovedAction({ store, caseRecord, body });
  if (primaryConfirmed) {
    proposed.action.exposureId = primaryConfirmed.id;
    proposed.action.brokerId = primaryConfirmed.brokerId;
  }
  return proposed;
}

export function createBrokerOptOutApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  const preset = getPreset(plan.presetId);
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const limit = plan.batchApprovalPolicy?.maxDestinations ?? confirmed.length;
  const targets = confirmed.slice(0, limit);
  const allowedIdentifiers = preset.requiredIdentifierCategories.filter((category) => category !== "password");
  const results: Array<{ approval: Approval; action: ActionRequest }> = [];
  for (const exposure of targets) {
    const catalog = exposure.brokerId ? brokerCatalogEntryById(exposure.brokerId) : undefined;
    const destination = catalog?.officialOptOutUrl ?? exposure.officialOptOutUrl ?? exposure.sourceUrl;
    const dataToDisclose = catalog
      ? dataToDiscloseForBroker(catalog, allowedIdentifiers)
      : allowedIdentifiers.slice(0, 3);
    const body: ProposedActionInput = {
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination,
      purpose: `Opt out of ${catalog?.brokerLabel ?? exposure.brokerLabel ?? "people-search"} listing at approved profile URL.`,
      identifiers: allowedIdentifiers,
      dataToDisclose: dataToDisclose.length ? dataToDisclose : ["legal-name", "email"],
      sourceVerified: true,
      expectedConfirmationStep: "User reviews broker destination, approved identifiers, and profile URL before submission."
    };
    const proposed = proposeApprovedAction({ store, caseRecord, body });
    proposed.action.brokerId = exposure.brokerId ?? catalog?.brokerId;
    proposed.action.exposureId = exposure.id;
    if (catalog && !catalog.teeAutomatable) {
      proposed.action.draftText = [
        proposed.action.draftText,
        "",
        `Submission method: ${catalog.submissionMethod}. User-held steps may be required.`
      ].join("\n");
    }
    results.push(proposed);
  }
  return results.length ? results : [createPresetApproval(store, caseRecord, plan.presetId)];
}

function contentTakedownHostForExposure(exposure: Exposure): string {
  return hostFromDestination(exposure.sourceUrl) || exposure.sourceUrl;
}

function proposeDmcaTakedownApproval(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    destination: string;
    purpose: string;
    exposureId?: string;
    expectedConfirmationStep?: string;
  }
): { approval: Approval; action: ActionRequest } {
  const proposed = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "dmca-takedown",
      destination: input.destination,
      purpose: input.purpose,
      identifiers: ["legal-name", "email", "infringing-url", "original-work-ref"],
      dataToDisclose: ["legal-name", "email", "infringing-url"],
      sourceVerified: true,
      expectedConfirmationStep:
        input.expectedConfirmationStep ??
        "User confirms they are the rights holder or authorized agent before DMCA submission."
    }
  });
  if (input.exposureId) proposed.action.exposureId = input.exposureId;
  return proposed;
}

function proposePlatformAbuseApproval(
  store: MemoryStore,
  caseRecord: CaseRecord,
  input: {
    destination: string;
    infringingUrl: string;
    exposureId?: string;
    expectedConfirmationStep?: string;
  }
): { approval: Approval; action: ActionRequest } {
  const contact = resolveHostAbuseContact(input.destination, input.infringingUrl);
  const host = contact?.host ?? input.destination;
  const abuseChannel = contact?.email ?? `abuse@${host}`;
  const proposed = proposeApprovedAction({
    store,
    caseRecord,
    body: {
      caseId: caseRecord.id,
      actionType: "platform-abuse-report",
      destination: host,
      purpose: `Report unauthorized copy at ${input.infringingUrl} via ${abuseChannel}.`,
      identifiers: ["legal-name", "email", "infringing-url", "original-work-ref"],
      dataToDisclose: ["legal-name", "email", "infringing-url"],
      sourceVerified: true,
      expectedConfirmationStep:
        input.expectedConfirmationStep ??
        "User confirms host abuse contact and infringing URL before platform abuse submission."
    }
  });
  if (input.exposureId) proposed.action.exposureId = input.exposureId;
  return proposed;
}

export function createContentTakedownApprovals(
  store: MemoryStore,
  caseRecord: CaseRecord,
  plan: AgentPlan
): Array<{ approval: Approval; action: ActionRequest }> {
  const confirmed = store.exposuresForCase(caseRecord.id).filter((item) => item.matchStatus === "confirmed");
  const limit = plan.batchApprovalPolicy?.maxDestinations ?? confirmed.length;
  const targets = confirmed.slice(0, limit || 1);
  if (!targets.length) {
    return [
      proposeDmcaTakedownApproval(store, caseRecord, {
        destination: "Infringing host abuse contact",
        purpose: "Remove unauthorized copies of approved original work at pasted URLs."
      }),
      proposePlatformAbuseApproval(store, caseRecord, {
        destination: "Infringing host",
        infringingUrl: "https://infringing.example/unauthorized-copy",
        expectedConfirmationStep:
          "User confirms host abuse contact and infringing URL before platform abuse submission."
      })
    ];
  }
  const results: Array<{ approval: Approval; action: ActionRequest }> = [];
  for (const exposure of targets) {
    const host = contentTakedownHostForExposure(exposure);
    results.push(
      proposeDmcaTakedownApproval(store, caseRecord, {
        destination: host,
        purpose: `Takedown unauthorized copy at ${exposure.sourceUrl}. Rights-holder authority confirmed in intake.`,
        exposureId: exposure.id
      }),
      proposePlatformAbuseApproval(store, caseRecord, {
        destination: host,
        infringingUrl: exposure.sourceUrl,
        exposureId: exposure.id
      })
    );
  }
  return results;
}