import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";

const SAMPLE_BROKER_URLS = [
  "https://www.fastbackgroundcheck.com/people/john-smith/id/f-example123456789",
  "https://rocketreach.co/john-smith-email_example",
  "https://thatsthem.com/name/John-Smith",
  "https://www.anywho.com/people/john+smith/new+york"
];

const { server } = createApp();
server.listen(0);
await once(server, "listening");
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

try {
  const created = await post("/api/cases", { jurisdiction: "US", authorityBasis: "self" }, 201);
  const caseId = created.case.id;
  await post(`/api/cases/${caseId}/intake`, {
    encryptedIntake: encryptedBlob(caseId),
    redactedScope: {
      personLabel: "John Smith",
      aliases: ["J. Smith"],
      approvedIdentifierLabels: ["city-state"],
      sensitiveConstraints: ["New York"]
    }
  });
  await post(`/api/cases/${caseId}/preset`, { presetId: "people-search-cleanup" }, 201);

  const discovered = await post(`/api/cases/${caseId}/findings/discover`, { pastedUrls: SAMPLE_BROKER_URLS }, 201);
  assert.ok(discovered.discovered.length >= 4, `expected 4 broker links, got ${discovered.discovered.length}`);
  const hosts = discovered.discovered.map((item) => new URL(item.sourceUrl).hostname);
  assert.ok(hosts.some((h) => h.includes("fastbackgroundcheck")));
  assert.ok(hosts.some((h) => h.includes("rocketreach")));
  assert.ok(hosts.some((h) => h.includes("thatsthem")));
  assert.ok(hosts.some((h) => h.includes("anywho")));

  const list = await get(`/api/cases/${caseId}/findings`);
  assert.equal(list.pendingFindings.length, discovered.discovered.length);

  for (const finding of list.pendingFindings) {
    const likely =
      finding.matchScore === "likely" ||
      finding.brokerId ||
      SAMPLE_BROKER_URLS.some((url) => url.includes(new URL(finding.sourceUrl).hostname));
    if (likely) {
      await post(`/api/cases/${caseId}/findings/${finding.id}/confirm`, {}, 200);
    } else {
      await post(`/api/cases/${caseId}/findings/${finding.id}/reject`, {}, 200);
    }
  }

  const after = await get(`/api/cases/${caseId}/findings`);
  assert.ok(after.confirmedFindings.length >= 4);

  for (let i = 0; i < 12; i += 1) {
    const next = await get(`/api/agent/next?caseId=${caseId}`);
    if (next.action === "request-approval" && next.blockedReasons?.includes("approval-required")) break;
    await post(`/api/cases/${caseId}/agent/run`, {}, 200);
  }

  const status = await get(`/api/cases/${caseId}`);
  assert.ok(status.status.approvalsNeeded.length >= 1, "broker opt-out approval should be proposed");
  const approval = status.status.approvalsNeeded[0];
  assert.equal(approval.actionType, "broker-opt-out");

  await post(`/api/approvals/${approval.id}/approve`, {
    userConfirmation: "I approve broker opt-out for confirmed listings"
  });
  await post(`/api/actions/${status.status.actionsReady[0]?.id ?? ""}/execute`, {}, 200).catch(() => {});

  const finalPlan = await get(`/api/cases/${caseId}/plan`);
  assert.ok(finalPlan.connectorResults.length >= 1);
  console.log("smoke-people-search: OK", {
    discovered: discovered.discovered.length,
    confirmed: after.confirmedFindings.length,
    approval: approval.actionType,
    step: finalPlan.plan?.currentStep
  });
} finally {
  server.close();
}

async function get(path) {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function post(path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json));
  return json;
}

function encryptedBlob(aad) {
  return {
    alg: "AES-256-GCM",
    keyId: "test-key",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "BBBBBBBBBBBBBBBB",
    aad
  };
}