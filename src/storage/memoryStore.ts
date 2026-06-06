import type {
  ActionRequest,
  AgentDelegation,
  AgentMessage,
  AgentPlan,
  AgentTimelineEvent,
  Approval,
  CaseRecord,
  ConnectorResult,
  Exposure,
  FollowUp,
  PaymentSession,
  PermissionGrant,
  RelayerEvent,
  VeniceAnalysis,
  SourceCheck
} from "../domain/types.js";
import type { OblivionRepository } from "./repository.js";

export class MemoryStore implements OblivionRepository {
  readonly cases = new Map<string, CaseRecord>();
  readonly approvals = new Map<string, Approval>();
  readonly actions = new Map<string, ActionRequest>();
  readonly exposures = new Map<string, Exposure>();
  readonly sourceChecks = new Map<string, SourceCheck>();
  readonly followUps = new Map<string, FollowUp>();
  readonly paymentSessions = new Map<string, PaymentSession>();
  readonly permissionGrants = new Map<string, PermissionGrant>();
  readonly relayerEvents = new Map<string, RelayerEvent>();
  readonly veniceAnalyses = new Map<string, VeniceAnalysis>();
  readonly agentDelegations = new Map<string, AgentDelegation>();
  readonly agentMessages = new Map<string, AgentMessage>();
  readonly agentTimeline = new Map<string, AgentTimelineEvent>();
  readonly agentPlans = new Map<string, AgentPlan>();
  readonly connectorResults = new Map<string, ConnectorResult>();
  readonly tombstones = new Map<string, string>();

  getCaseOrThrow(caseId: string): CaseRecord {
    const caseRecord = this.cases.get(caseId);
    if (!caseRecord || caseRecord.deletedAt) {
      throw Object.assign(new Error("case-not-found"), { statusCode: 404 });
    }
    return caseRecord;
  }

  approvalsForCase(caseId: string): Approval[] {
    return [...this.approvals.values()].filter((approval) => approval.caseId === caseId);
  }

  actionsForCase(caseId: string): ActionRequest[] {
    return [...this.actions.values()].filter((action) => action.caseId === caseId);
  }

  exposuresForCase(caseId: string): Exposure[] {
    return [...this.exposures.values()].filter((exposure) => exposure.caseId === caseId);
  }

  followUpsForCase(caseId: string): FollowUp[] {
    return [...this.followUps.values()].filter((followUp) => followUp.caseId === caseId);
  }

  paymentSessionsForCase(caseId: string): PaymentSession[] {
    return [...this.paymentSessions.values()].filter((session) => session.caseId === caseId);
  }

  permissionGrantsForCase(caseId: string): PermissionGrant[] {
    return [...this.permissionGrants.values()].filter((grant) => grant.caseId === caseId);
  }

  relayerEventsForCase(caseId: string): RelayerEvent[] {
    return [...this.relayerEvents.values()].filter((event) => event.caseId === caseId);
  }

  veniceAnalysesForCase(caseId: string): VeniceAnalysis[] {
    return [...this.veniceAnalyses.values()].filter((analysis) => analysis.caseId === caseId);
  }

  agentDelegationsForCase(caseId: string): AgentDelegation[] {
    return [...this.agentDelegations.values()].filter((delegation) => delegation.caseId === caseId);
  }

  agentMessagesForCase(caseId: string): AgentMessage[] {
    return [...this.agentMessages.values()].filter((message) => message.caseId === caseId);
  }

  agentTimelineForCase(caseId: string): AgentTimelineEvent[] {
    return [...this.agentTimeline.values()]
      .filter((event) => event.caseId === caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  agentPlanForCase(caseId: string): AgentPlan | undefined {
    return [...this.agentPlans.values()]
      .filter((plan) => plan.caseId === caseId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  connectorResultsForCase(caseId: string): ConnectorResult[] {
    return [...this.connectorResults.values()]
      .filter((result) => result.caseId === caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
