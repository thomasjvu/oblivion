import { expect, test } from "@playwright/test";

const PARTNER_KEY = "obl_live_e2e_test";
const AUTH = { authorization: `Bearer ${PARTNER_KEY}`, "content-type": "application/json" };

test("partner API reaches approval gate", async ({ request }) => {
  const created = await request.post("/v1/cases", {
    headers: AUTH,
    data: { jurisdiction: "US", authorityBasis: "self", externalRef: `e2e_${Date.now()}` }
  });
  expect(created.ok()).toBeTruthy();
  const { case: caseRecord } = await created.json();
  const caseId = caseRecord.id as string;

  await request.post(`/v1/cases/${caseId}/intake`, {
    headers: AUTH,
    data: {
      encryptedIntake: {
        alg: "AES-256-GCM",
        keyId: "e2e-key",
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "BBBBBBBBBBBBBBBB",
        aad: caseId
      },
      redactedScope: {
        personLabel: "J.S.",
        aliases: [],
        approvedIdentifierLabels: ["email", "legal-name", "city-state"],
        sensitiveConstraints: []
      }
    }
  });

  await request.post(`/v1/cases/${caseId}/preset`, {
    headers: AUTH,
    data: { presetId: "people-search-cleanup" }
  });

  await request.post(`/v1/cases/${caseId}/discover`, {
    headers: AUTH,
    data: { pastedUrls: ["https://www.spokeo.com/example/listing"] }
  });

  const exposures = await request.get(`/v1/cases/${caseId}/exposures`, { headers: AUTH });
  const exposureList = await exposures.json();
  const pending = exposureList.pending ?? exposureList.exposures?.filter((e: { matchStatus?: string }) => !e.matchStatus || e.matchStatus === "pending") ?? [];
  for (const exposure of pending.slice(0, 2)) {
    await request.post(`/v1/cases/${caseId}/exposures/${exposure.id}/confirm`, {
      headers: AUTH,
      data: {}
    });
  }

  for (let index = 0; index < 12; index += 1) {
    const run = await request.post(`/v1/cases/${caseId}/run-until-blocked`, {
      headers: AUTH,
      data: { maxIterations: 1 }
    });
    expect(run.ok()).toBeTruthy();
    const result = await run.json();
    if (result.stoppedBecause === "approval-required") break;
    if (result.stoppedBecause === "complete") break;
  }

  await expect
    .poll(async () => {
      const status = await request.get(`/v1/cases/${caseId}/status`, { headers: AUTH });
      const json = await status.json();
      return json.pendingApprovals ?? 0;
    })
    .toBeGreaterThan(0);
});