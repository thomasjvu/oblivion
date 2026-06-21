import assert from "node:assert/strict";
import test from "node:test";
import type { FollowUp } from "../../src/domain/types.js";
import { partnerFetch, startPartnerServer } from "../helpers/partner.js";

test("partner recheck endpoint triggers due follow-ups", async () => {
  const { server, base, store } = await startPartnerServer();

  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "recheck-case" },
      expectedStatus: 201
    });
    const caseId = created.json.case.id as string;
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const followUp: FollowUp = {
      id: "followup_api",
      caseId,
      dueDate: past,
      status: "pending",
      expectedResponseWindow: "Recheck broker listing",
      escalationPath: "Follow up"
    };
    store.followUps.set(followUp.id, followUp);

    const result = await partnerFetch(base, `/v1/cases/${caseId}/recheck`, {
      method: "POST",
      body: {},
      expectedStatus: 200
    });
    assert.equal(result.json.triggered.length, 1);
    assert.equal(result.json.triggered[0].status, "triggered");
  } finally {
    server.close();
  }
});