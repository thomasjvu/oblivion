import { caseActivationView } from "./caseActivation.js";
import type { ActionRequest, Approval, CaseRecord, CaseStatus, Exposure, FollowUp } from "./types.js";
import type { MemoryStore } from "../storage/memoryStore.js";

export function buildCaseStatus(input: {
  store: MemoryStore;
  caseRecord: CaseRecord;
  exposures: Exposure[];
  approvals: Approval[];
  actions: ActionRequest[];
  followUps: FollowUp[];
}): CaseStatus {
  const pendingFindings = input.exposures.filter((exposure) => (exposure.matchStatus ?? "pending") === "pending");
  const confirmedFindings = input.exposures.filter((exposure) => exposure.matchStatus === "confirmed");
  const activation = caseActivationView(input.store, input.caseRecord);
  return {
    scope: input.caseRecord.redactedScope ?? null,
    findings: input.exposures,
    pendingFindings,
    confirmedFindings,
    approvalsNeeded: input.approvals.filter((approval) => approval.status === "pending"),
    actionsReady: input.actions.filter((action) => action.executionStatus === "ready"),
    submittedActions: input.actions.filter((action) =>
      action.executionStatus === "recorded" || action.executionStatus === "executed"
    ),
    nextChecks: input.followUps,
    activated: activation.activated,
    activationRequired: activation.activationRequired
  };
}
