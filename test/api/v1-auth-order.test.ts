import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../../src/api/app.js";
import { createCaseRecord } from "../../src/domain/cases.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { Approval, PartnerRecord } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { DEFAULT_TEST_KEY, partnerFetch, seedTestPartner } from "../helpers/partner.js";

const OTHER_PARTNER_KEY = "obl_other_partner_secret";

async function startTwoPartnerServer(): Promise<{
  server: Server;
  store: ReturnType<typeof createApp>["store"];
  base: string;
}> {
  const { server, store } = createApp({ store: new MemoryStore() });
  seedTestPartner(store, { id: "owner", key: DEFAULT_TEST_KEY });
  const now = new Date().toISOString();
  const other: PartnerRecord = {
    id: "intruder",
    name: "Intruder Partner",
    apiKeyHash: hashPartnerApiKey(OTHER_PARTNER_KEY),
    environment: "production",
    balanceCredits: 100,
    webhookEvents: [],
    createdAt: now,
    updatedAt: now
  };
  store.partners.set(other.id, other);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  return { server, store, base };
}

test("v1 approve rejects partner that does not own the case before handler", async () => {
  const { server, store, base } = await startTwoPartnerServer();
  try {
    const { caseRecord } = createCaseRecord({
      jurisdiction: "US",
      authorityBasis: "self",
      partnerId: "owner",
      externalRef: "auth_order_1"
    });
    store.cases.set(caseRecord.id, caseRecord);
    const approval: Approval = {
      id: "approval_cross",
      caseId: caseRecord.id,
      actionType: "broker-opt-out",
      destination: "broker",
      identifiersApproved: ["email"],
      dataToDisclose: ["email"],
      purpose: "Remove profile",
      disclosureRisk: "Disclosure to broker",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString()
    };
    store.approvals.set(approval.id, approval);

    const blocked = await fetch(`${base}/v1/approvals/${approval.id}/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OTHER_PARTNER_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ userConfirmation: "I approve this broker opt-out" })
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "case-not-owned-by-partner");
    assert.equal(store.approvals.get(approval.id)?.status, "pending");

    const allowed = await partnerFetch(base, `/v1/approvals/${approval.id}/approve`, {
      method: "POST",
      body: { userConfirmation: "I approve this broker opt-out" },
      expectedStatus: 200,
      apiKey: DEFAULT_TEST_KEY
    });
    assert.equal(allowed.json.approval.status, "approved");
  } finally {
    server.close();
  }
});