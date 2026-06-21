import assert from "node:assert/strict";
import test from "node:test";
import { activateTestCase, encryptedBlob } from "../helpers/http.js";
import { partnerFetch, startPartnerServer } from "../helpers/partner.js";

test("partner run-until-blocked stops when approvals are required", async () => {
  const { server, base, store } = await startPartnerServer();
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "agent_run_1" },
      expectedStatus: 201
    });
    const caseId = created.json.case.id as string;
    activateTestCase(store, caseId);
    await partnerFetch(base, `/v1/cases/${caseId}/intake`, {
      method: "POST",
      body: {
        encryptedIntake: encryptedBlob(caseId),
        redactedScope: {
          personLabel: "A.B.",
          aliases: [],
          approvedIdentifierLabels: ["email"],
          sensitiveConstraints: []
        }
      },
      expectedStatus: 200
    });
    await partnerFetch(base, `/v1/cases/${caseId}/preset`, {
      method: "POST",
      body: { presetId: "people-search-cleanup" },
      expectedStatus: 201
    });
    const result = await partnerFetch(base, `/v1/cases/${caseId}/run-until-blocked`, {
      method: "POST",
      body: { maxIterations: 3 },
      expectedStatus: 200
    });
    assert.ok(result.json.iterations >= 1);
    assert.ok(
      ["approval-required", "blocked", "complete", "max-iterations"].includes(result.json.stoppedBecause)
    );
  } finally {
    server.close();
  }
});