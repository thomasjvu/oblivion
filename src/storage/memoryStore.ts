import { DomainError } from "../domain/errors.js";
import type {
  ActionRequest,
  AgentDelegation,
  AgentMessage,
  AgentPlan,
  AgentTimelineEvent,
  Approval,
  CaseRecord,
  ConnectorResult,
  CreditAccount,
  CreditLedgerEntry,
  Exposure,
  FollowUp,
  PartnerDataAccessEvent,
  PartnerInvoice,
  PartnerRecord,
  PartnerUsageEntry,
  PartnerWebhookDelivery,
  PartnerWebhookInboxEntry,
  PaymentSession,
  PermissionGrant,
  RelayerEvent,
  VeniceAnalysis,
  SourceCheck
} from "../domain/types.js";
import { CaseIndexedMap } from "./caseIndexedMap.js";
import { CaseStoreMap } from "./caseStoreMap.js";
import type { OblivionRepository } from "./repository.js";

export class MemoryStore implements OblivionRepository {
  private dirty = false;

  readonly cases = new CaseStoreMap();
  readonly approvals = new CaseIndexedMap<Approval>();
  readonly actions = new CaseIndexedMap<ActionRequest>();
  readonly exposures = new CaseIndexedMap<Exposure>();
  readonly sourceChecks = new CaseIndexedMap<SourceCheck>();
  readonly followUps = new CaseIndexedMap<FollowUp>();
  readonly paymentSessions = new CaseIndexedMap<PaymentSession>();
  readonly permissionGrants = new CaseIndexedMap<PermissionGrant>();
  readonly relayerEvents = new CaseIndexedMap<RelayerEvent>();
  readonly veniceAnalyses = new CaseIndexedMap<VeniceAnalysis>();
  readonly agentDelegations = new CaseIndexedMap<AgentDelegation>();
  readonly agentMessages = new CaseIndexedMap<AgentMessage>();
  readonly agentTimeline = new CaseIndexedMap<AgentTimelineEvent>();
  readonly agentPlans = new CaseIndexedMap<AgentPlan>();
  readonly connectorResults = new CaseIndexedMap<ConnectorResult>();
  readonly creditAccounts = new Map<string, CreditAccount>();
  readonly creditLedger = new Map<string, CreditLedgerEntry>();
  readonly partners = new Map<string, PartnerRecord>();
  readonly partnerUsage = new Map<string, PartnerUsageEntry>();
  readonly partnerInvoices = new Map<string, PartnerInvoice>();
  readonly partnerDataAccess = new Map<string, PartnerDataAccessEvent>();
  readonly webhookDeliveries = new Map<string, PartnerWebhookDelivery>();
  readonly partnerWebhookInbox = new Map<string, PartnerWebhookInboxEntry>();
  readonly tombstones = new Map<string, string>();
  readonly discoveryPreviewUsage = new Map<string, { day: string; count: number }>();

  casesForPartner(partnerId: string): CaseRecord[] {
    return this.cases.valuesForPartner(partnerId);
  }

  getCaseOrThrow(caseId: string): CaseRecord {
    const caseRecord = this.cases.get(caseId);
    if (!caseRecord || caseRecord.deletedAt) {
      throw new DomainError("case-not-found", 404);
    }
    return caseRecord;
  }

  approvalsForCase(caseId: string): Approval[] {
    return this.approvals.valuesForCase(caseId);
  }

  actionsForCase(caseId: string): ActionRequest[] {
    return this.actions.valuesForCase(caseId);
  }

  exposuresForCase(caseId: string): Exposure[] {
    return this.exposures.valuesForCase(caseId);
  }

  followUpsForCase(caseId: string): FollowUp[] {
    return this.followUps.valuesForCase(caseId);
  }

  paymentSessionsForCase(caseId: string): PaymentSession[] {
    return this.paymentSessions.valuesForCase(caseId);
  }

  permissionGrantsForCase(caseId: string): PermissionGrant[] {
    return this.permissionGrants.valuesForCase(caseId);
  }

  relayerEventsForCase(caseId: string): RelayerEvent[] {
    return this.relayerEvents.valuesForCase(caseId);
  }

  veniceAnalysesForCase(caseId: string): VeniceAnalysis[] {
    return this.veniceAnalyses.valuesForCase(caseId);
  }

  agentDelegationsForCase(caseId: string): AgentDelegation[] {
    return this.agentDelegations.valuesForCase(caseId);
  }

  agentMessagesForCase(caseId: string): AgentMessage[] {
    return this.agentMessages.valuesForCase(caseId);
  }

  agentTimelineForCase(caseId: string): AgentTimelineEvent[] {
    return this.agentTimeline
      .valuesForCase(caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  agentPlanForCase(caseId: string): AgentPlan | undefined {
    return this.agentPlans
      .valuesForCase(caseId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  connectorResultsForCase(caseId: string): ConnectorResult[] {
    return this.connectorResults
      .valuesForCase(caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }
}