import test from "node:test";
import assert from "node:assert/strict";
import { createCaseRecord } from "../../src/domain/cases.js";
import { deleteCaseRecord } from "../../src/api/handlers/caseLifecycle.js";
import {
  assertExportBundleHasNoSecrets,
  buildCaseExportBundle,
  DELETE_PRIVACY_GUARANTEES,
  EXPORT_PRIVACY_MATRIX,
  redactedApprovalForExport
} from "../../src/domain/exportPrivacy.js";
import { purgeCaseData } from "../../src/domain/purgeCase.js";
import { recordPartnerDataAccess } from "../../src/domain/partnerAudit.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import type { ActionRequest, Approval, PartnerRecord } from "../../src/domain/types.js";

function seedCaseWithSecrets(store: MemoryStore) {
  const { caseRecord } = createCaseRecord({
    jurisdiction: "US",
    authorityBasis: "self",
    partnerId: "partner_privacy"
  });
  caseRecord.encryptedIntake = {
    alg: "AES-256-GCM",
    keyId: "key_1",
    nonce: "nonce_1",
    ciphertext: "ciphertext_1",
    aad: caseRecord.id
  };
  store.cases.set(caseRecord.id, caseRecord);

  const approval: Approval = {
    id: "approval_export",
    caseId: caseRecord.id,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove profile",
    disclosureRisk: "Disclosure to broker",
    status: "approved",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    userConfirmation: "I approve sending person@example.com to Example Broker"
  };
  store.approvals.set(approval.id, approval);

  const action: ActionRequest = {
    id: "action_export",
    caseId: caseRecord.id,
    actionType: "broker-opt-out",
    destination: "Example Broker",
    template: "broker-opt-out",
    draftText: "Please remove person@example.com from your database.",
    expectedConfirmationStep: "Confirm",
    approvalId: approval.id,
    executionStatus: "ready",
    createdAt: new Date().toISOString()
  };
  store.actions.set(action.id, action);

  return caseRecord;
}

test("export privacy matrix documents consumer vs partner field policy", () => {
  assert.equal(EXPORT_PRIVACY_MATRIX.consumer.includeAgentTimeline, true);
  assert.equal(EXPORT_PRIVACY_MATRIX.partner.includeAgentTimeline, false);
  assert.equal(EXPORT_PRIVACY_MATRIX.partner.includePartnerStatus, true);
  assert.equal(EXPORT_PRIVACY_MATRIX.consumer.includePartnerStatus, false);
});

test("redacted approval export never includes confirmation text", () => {
  const view = redactedApprovalForExport({
    id: "approval_1",
    caseId: "case_1",
    actionType: "broker-opt-out",
    destination: "broker",
    identifiersApproved: ["email"],
    dataToDisclose: ["email"],
    purpose: "Remove",
    disclosureRisk: "risk",
    status: "approved",
    expiresAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    userConfirmation: "secret confirmation text"
  });
  assert.equal(view.userConfirmationProvided, true);
  assert.equal("userConfirmation" in view, false);
});

test("consumer and partner export bundles omit secret fields", () => {
  const store = new MemoryStore();
  const caseRecord = seedCaseWithSecrets(store);

  for (const audience of ["consumer", "partner"] as const) {
    const bundle = buildCaseExportBundle(store, caseRecord, audience);
    const serialized = JSON.stringify(bundle);
    const violations = assertExportBundleHasNoSecrets(serialized);
    assert.deepEqual(violations, [], `${audience} export leaked secrets: ${violations.join(", ")}`);
    assert.doesNotMatch(serialized, /person@example\.com/);
    assert.doesNotMatch(serialized, /accessTokenHash/);
    if (audience === "partner") {
      assert.equal((bundle.case as { encryptedIntake?: { ciphertext: string } }).encryptedIntake?.ciphertext, "ciphertext_1");
    }
  }
});

test("delete privacy guarantees purge case data but retain partner audit trail", async () => {
  const store = new MemoryStore();
  const caseRecord = seedCaseWithSecrets(store);
  recordPartnerDataAccess(store, {
    partnerId: "partner_privacy",
    caseId: caseRecord.id,
    action: "export",
    source: "v1"
  });

  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: "partner_privacy",
    name: "Privacy Partner",
    apiKeyHash: "hash",
    environment: "sandbox",
    balanceCredits: 0,
    webhookEvents: [],
    createdAt: now,
    updatedAt: now
  };
  const deleted = await deleteCaseRecord(store, caseRecord, { partner, emitWebhook: false, auditSource: "v1" });

  assert.equal(DELETE_PRIVACY_GUARANTEES.clearsEncryptedIntake, true);
  assert.equal(caseRecord.encryptedIntake, undefined);
  assert.equal(caseRecord.encryptedVaultPointer, "deleted");
  assert.ok(deleted.tombstone);
  assert.equal(store.approvalsForCase(caseRecord.id).length, 0);
  assert.equal(store.actionsForCase(caseRecord.id).length, 0);
  assert.equal(store.partnerDataAccess.size, 2);
  const actions = [...store.partnerDataAccess.values()].map((event) => event.action).sort();
  assert.deepEqual(actions, ["delete", "export"]);
  purgeCaseData(store, caseRecord.id);
  assert.equal(store.exposuresForCase(caseRecord.id).length, 0);
});