import test from "node:test";
import assert from "node:assert/strict";
import {
  activateTestCase,
  createCaseWithIntake,
  get,
  post,
  runUntilApproval,
  startTestServer
} from "../helpers/http.js";

test("cleanup presets render every launch route and enforce jurisdiction", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const presets = await get(base, "/api/presets");
    assert.deepEqual(presets.presets.map((preset: any) => preset.id), [
      "people-search-cleanup",
      "search-result-suppression",
      "california-drop",
      "gdpr-erasure",
      "breach-exposure",
      "high-risk-safety",
      "content-takedown"
    ]);

    const euCase = await post(base, "/api/cases", {
      jurisdiction: "EU",
      authorityBasis: "self"
    }, 201);
    activateTestCase(store, euCase.case.id);
    await post(base, `/api/cases/${euCase.case.id}/preset`, {
      presetId: "california-drop"
    }, 422);
  } finally {
    server.close();
  }
});

test("high-risk safety plan stops at candidate confirmation", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await createCaseWithIntake(base, "US", "high-risk-safety", store);
    const caseId = created.caseId;
    await post(base, `/api/cases/${caseId}/preset`, {
      presetId: "high-risk-safety"
    }, 201);

    for (let index = 0; index < 5; index += 1) {
      const next = await get(base, `/api/agent/next?caseId=${caseId}`);
      if (next.blockedReasons?.includes("candidate-confirmation-needed")) break;
      await post(base, `/api/cases/${caseId}/agent/run`, {});
    }

    const blocked = await get(base, `/api/agent/next?caseId=${caseId}`);
    assert.equal(blocked.action, "confirm-matches");
    assert.deepEqual(blocked.blockedReasons, ["candidate-confirmation-needed"]);
    const plan = await get(base, `/api/cases/${caseId}/plan`);
    assert.equal(plan.connectorResults[0].requiresUserHandoff, true);
  } finally {
    server.close();
  }
});

test("HIBP password range connector sends only the SHA-1 prefix", async () => {
  const { server, base, store } = await startTestServer();
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  try {
    const created = await createCaseWithIntake(base, "US", "standard", store);
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://api.pwnedpasswords.com/range/")) {
        requestedUrl = target;
        return new Response("ABCDEF:12\r\n123456:1", { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const result = await post(base, "/api/connectors/hibp/password-range", {
      caseId: created.caseId,
      hashPrefix: "abc12"
    });

    assert.equal(requestedUrl, "https://api.pwnedpasswords.com/range/ABC12");
    assert.deepEqual(result.transmitted, ["hashPrefix"]);
    assert.deepEqual(result.neverTransmit, ["password"]);
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test("HIBP email check requires exact approval and TEE verified runtime", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await createCaseWithIntake(base, "US", "standard", store);
    await post(base, "/api/connectors/hibp/email-check", {
      caseId: created.caseId,
      emailLabel: "person@example.com"
    }, 403);

    await post(base, `/api/cases/${created.caseId}/preset`, {
      presetId: "breach-exposure"
    }, 201);
    await runUntilApproval(base, created.caseId);
    const current = await get(base, `/api/cases/${created.caseId}`);
    const approval = current.status.approvalsNeeded[0];
    assert.equal(approval.actionType, "hibp-email-check");
    await post(base, `/api/approvals/${approval.id}/approve`, {
      userConfirmation: "I approve this HIBP email check"
    });
    const blocked = await post(base, "/api/connectors/hibp/email-check", {
      caseId: created.caseId,
      approvalId: approval.id,
      emailLabel: "person@example.com"
    }, 403);
    assert.equal(blocked.error, "runtime-not-tee-verified");
  } finally {
    server.close();
  }
});

test("Google removal connector separates source deletion from search suppression", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await createCaseWithIntake(base, "US", "standard", store);
    const plan = await post(base, "/api/connectors/google/removal-plan", {
      caseId: created.caseId,
      sourceUrl: "https://example.invalid/profile"
    }, 201);
    assert.equal(plan.result.connectorId, "google-removal-plan");
    assert.equal(plan.result.requiresUserHandoff, true);
    assert.match(plan.result.summary, /source-page deletion from search-result suppression/);
    const exported = await post(base, "/api/export", { caseId: created.caseId });
    assert.equal(exported.sourceChecks[0].officialUrl, "https://support.google.com/websearch/answer/12719076");
  } finally {
    server.close();
  }
});