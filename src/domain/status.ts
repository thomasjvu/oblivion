import type { ActionRequest, Approval, CaseRecord, CaseStatus, Exposure, FollowUp } from "./types.js";

export function buildCaseStatus(input: {
  caseRecord: CaseRecord;
  exposures: Exposure[];
  approvals: Approval[];
  actions: ActionRequest[];
  followUps: FollowUp[];
}): CaseStatus {
  return {
    scope: input.caseRecord.redactedScope ?? null,
    findings: input.exposures,
    approvalsNeeded: input.approvals.filter((approval) => approval.status === "pending"),
    actionsReady: input.actions.filter((action) => action.executionStatus === "ready"),
    submittedActions: input.actions.filter((action) => action.executionStatus === "recorded"),
    nextChecks: input.followUps
  };
}
