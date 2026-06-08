import assert from "node:assert/strict";
import test from "node:test";
import { encryptedBlob } from "../helpers/http.js";
import { partnerFetch, startPartnerServer } from "../helpers/partner.js";

const TEST_KEY = "obl_privacy_partner_key";
const TEST_PARTNER_ID = "privpartner";

test("partner export and delete create audit trail without leaking confirmation text", async () => {
  const { server, base } = await startPartnerServer({
    id: TEST_PARTNER_ID,
    key: TEST_KEY,
    name: "Privacy Partner",
    balanceCredits: 500
  });
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self", externalRef: "privacy_1" },
      expectedStatus: 201,
      apiKey: TEST_KEY
    });
    const caseId = created.json.case.id as string;
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
      expectedStatus: 200,
      apiKey: TEST_KEY
    });

    const exported = await partnerFetch(base, `/v1/cases/${caseId}/export`, {
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    const serialized = JSON.stringify(exported.json);
    assert.doesNotMatch(serialized, /userConfirmation/);
    assert.equal(exported.json.case.encryptedIntake.ciphertext, encryptedBlob(caseId).ciphertext);

    const audit = await partnerFetch(base, "/v1/partners/me/data-access", {
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    assert.equal(audit.json.events.length, 1);
    assert.equal(audit.json.events[0].action, "export");

    await partnerFetch(base, `/v1/cases/${caseId}`, { method: "DELETE", expectedStatus: 200, apiKey: TEST_KEY });
    const auditAfterDelete = await partnerFetch(base, "/v1/partners/me/data-access", {
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    assert.equal(auditAfterDelete.json.events[0].action, "delete");
  } finally {
    server.close();
  }
});

test("partner authenticated consumer export is allowed and audited", async () => {
  const { server, base } = await startPartnerServer({
    id: TEST_PARTNER_ID,
    key: TEST_KEY,
    name: "Privacy Partner"
  });
  try {
    const created = await partnerFetch(base, "/v1/cases", {
      method: "POST",
      body: { jurisdiction: "US", authorityBasis: "self" },
      expectedStatus: 201,
      apiKey: TEST_KEY
    });
    const caseId = created.json.case.id as string;
    const exported = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ caseId })
    });
    assert.equal(exported.status, 200);
    const audit = await partnerFetch(base, "/v1/partners/me/data-access?caseId=" + caseId, {
      expectedStatus: 200,
      apiKey: TEST_KEY
    });
    assert.equal(audit.json.events[0].action, "export");
    assert.equal(audit.json.events[0].source, "api");
  } finally {
    server.close();
  }
});