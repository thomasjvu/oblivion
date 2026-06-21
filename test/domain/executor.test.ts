import assert from "node:assert/strict";
import test from "node:test";
import { executeApprovedAction, executeApprovedActionFlow } from "../../src/domain/executor.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ActionRequest, Approval, CaseRecord } from "../../src/domain/types.js";
import type { TrustCenterConfig } from "../../src/domain/attestation.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

const trustConfig: TrustCenterConfig = {
  deploymentVersion: "0.1.0",
  sourceCommit: "test",
  expectedComposeHash: "replace-me",
  imageDigests: [],
  verificationInstructions: []
};

function seedApproval(caseId: string): { approval: Approval; action: ActionRequest } {
  const now = new Date().toISOString();
  const approval: Approval = {
    id: "approval_exec",
    caseId,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove listing",
    disclosureRisk: "Broker disclosure",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "approved",
    createdAt: now
  };
  const action: ActionRequest = {
    id: "action_exec",
    caseId,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    template: "broker-opt-out",
    draftText: "Draft",
    deadlineBasis: "broker-response-window",
    expectedConfirmationStep: "Confirm",
    approvalId: approval.id,
    executionStatus: "ready",
    createdAt: now
  };
  return { approval, action };
}

test("executeApprovedActionFlow rejects second execute after success", async () => {
  const original = process.env.OBLIVION_EXECUTOR_MODE;
  process.env.OBLIVION_EXECUTOR_MODE = "record-only";
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_exec_flow",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_exec_flow",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  const { approval, action } = seedApproval(caseRecord.id);
  store.approvals.set(approval.id, approval);
  store.actions.set(action.id, action);
  try {
    await executeApprovedActionFlow({
      store,
      action,
      approval,
      trustCenterConfig: trustConfig
    });
    await assert.rejects(
      () =>
        executeApprovedActionFlow({
          store,
          action,
          approval,
          trustCenterConfig: trustConfig
        }),
      (error: unknown) =>
        error instanceof DomainError &&
        (error.code === "approval-not-executable" || error.code === "action-already-executed")
    );
  } finally {
    if (original === undefined) delete process.env.OBLIVION_EXECUTOR_MODE;
    else process.env.OBLIVION_EXECUTOR_MODE = original;
  }
});

test("executeApprovedAction records broker opt-out in record-only mode", async () => {
  const original = process.env.OBLIVION_EXECUTOR_MODE;
  process.env.OBLIVION_EXECUTOR_MODE = "record-only";
  const store = new MemoryStore();
  const now = new Date().toISOString();
  const caseRecord: CaseRecord = {
    id: "case_exec",
    jurisdiction: "US",
    authorityBasis: "self",
    riskLevel: "standard",
    retentionDays: 30,
    encryptedVaultPointer: "vault_exec",
    createdAt: now,
    updatedAt: now
  };
  store.cases.set(caseRecord.id, caseRecord);
  const { approval, action } = seedApproval(caseRecord.id);
  store.approvals.set(approval.id, approval);
  store.actions.set(action.id, action);
  try {
    const result = await executeApprovedAction({
      store,
      action,
      approval,
      trustCenterConfig: trustConfig
    });
    assert.equal(result.mode, "record-only");
    assert.match(result.executionRecord, /record-only executor/);
  } finally {
    if (original === undefined) delete process.env.OBLIVION_EXECUTOR_MODE;
    else process.env.OBLIVION_EXECUTOR_MODE = original;
  }
});