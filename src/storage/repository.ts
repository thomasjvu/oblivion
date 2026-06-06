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
  VeniceAnalysis
} from "../domain/types.js";

export interface OblivionRepository {
  getCaseOrThrow(caseId: string): CaseRecord;
  approvalsForCase(caseId: string): Approval[];
  actionsForCase(caseId: string): ActionRequest[];
  exposuresForCase(caseId: string): Exposure[];
  followUpsForCase(caseId: string): FollowUp[];
  paymentSessionsForCase(caseId: string): PaymentSession[];
  permissionGrantsForCase(caseId: string): PermissionGrant[];
  relayerEventsForCase(caseId: string): RelayerEvent[];
  veniceAnalysesForCase(caseId: string): VeniceAnalysis[];
  agentDelegationsForCase(caseId: string): AgentDelegation[];
  agentMessagesForCase(caseId: string): AgentMessage[];
  agentTimelineForCase(caseId: string): AgentTimelineEvent[];
  agentPlanForCase(caseId: string): AgentPlan | undefined;
  connectorResultsForCase(caseId: string): ConnectorResult[];
}

