import test from "node:test";
import assert from "node:assert/strict";
import { encryptVaultPayload, createVaultKey } from "../../src/crypto/clientVault.js";
import { activateTestCase, get, post, startTestServer } from "../helpers/http.js";

test("serves split frontend assets with restrictive security headers", async () => {
  const { server, base } = await startTestServer();

  try {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(html.headers.get("x-frame-options"), "DENY");
    assert.equal(html.headers.get("referrer-policy"), "no-referrer");

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /\/fonts\/GeistPixel-Square\.woff2/);

    const font = await fetch(`${base}/fonts/GeistPixel-Square.woff2`);
    assert.equal(font.status, 200);
    assert.match(font.headers.get("content-type") ?? "", /font\/woff2/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /application\/javascript/);
    const jsText = await js.text();
    const chunkMatch = jsText.match(/from"\.\/(chunk-[A-Z0-9]+\.js)"/);
    if (chunkMatch) {
      const chunk = await fetch(`${base}/${chunkMatch[1]}`);
      assert.equal(chunk.status, 200);
      assert.match(chunk.headers.get("content-type") ?? "", /application\/javascript/);
    }

    const heroWebp = await fetch(`${base}/assets/hero-dissolution.webp`);
    assert.equal(heroWebp.status, 200);
    assert.match(heroWebp.headers.get("content-type") ?? "", /image\/webp/);

    const heroVideo = await fetch(`${base}/assets/hero-dissolution.mp4`);
    assert.equal(heroVideo.status, 200);
    assert.match(heroVideo.headers.get("content-type") ?? "", /video\/mp4/);
    assert.match(html.headers.get("content-security-policy") ?? "", /media-src 'self'/);

    const skillScript = await fetch(`${base}/skill.sh`);
    assert.equal(skillScript.status, 200);
    assert.match(skillScript.headers.get("content-type") ?? "", /application\/x-sh|text\/plain/);
    assert.match(await skillScript.text(), /clean-online-identity/);

    const skillMd = await fetch(`${base}/skills/clean-online-identity/SKILL.md`);
    assert.equal(skillMd.status, 200);
    assert.match(skillMd.headers.get("content-type") ?? "", /text\/markdown/);

    const skillManifest = await fetch(`${base}/skills/clean-online-identity/manifest.json`);
    assert.equal(skillManifest.status, 200);
    const manifest = (await skillManifest.json()) as { files: string[] };
    assert.ok(manifest.files.includes("SKILL.md"));

    const skillsApi = await fetch(`${base}/api/skills`);
    assert.equal(skillsApi.status, 200);
    const skillsPayload = (await skillsApi.json()) as { skills: Array<{ id: string }> };
    assert.equal(skillsPayload.skills[0]?.id, "clean-online-identity");

    const walletConfig = await fetch(`${base}/api/integrations/wallet-config`);
    assert.equal(walletConfig.status, 200);
    const wc = (await walletConfig.json()) as { chainId: number; mode: string };
    assert.equal(wc.chainId, 11155111);

    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") ?? "", /image\/x-icon|image\/vnd\.microsoft\.icon/);

    const brandIcon = await fetch(`${base}/assets/brand/oblivion-agent-icon.webp`);
    assert.equal(brandIcon.status, 200);
    assert.match(brandIcon.headers.get("content-type") ?? "", /image\/webp/);

    const help = await fetch(`${base}/help`, { redirect: "manual" });
    assert.equal(help.status, 302);
    assert.match(help.headers.get("location") ?? "", /\/docs\/user-guide\/overview$/);

    const privacy = await fetch(`${base}/privacy`, { redirect: "manual" });
    assert.equal(privacy.status, 302);
    assert.match(privacy.headers.get("location") ?? "", /\/docs\/legal\/privacy$/);

    const terms = await fetch(`${base}/terms`, { redirect: "manual" });
    assert.equal(terms.status, 302);
    assert.match(terms.headers.get("location") ?? "", /\/docs\/legal\/terms$/);

    const pricing = await fetch(`${base}/pricing`, { redirect: "manual" });
    assert.equal(pricing.status, 302);
    assert.match(pricing.headers.get("location") ?? "", /\/docs\/pricing$/);

    const llms = await fetch(`${base}/llms`, { redirect: "manual" });
    assert.equal(llms.status, 302);
    assert.match(llms.headers.get("location") ?? "", /\/llms$/);

    const llmsTxt = await fetch(`${base}/llms.txt`, { redirect: "manual" });
    assert.equal(llmsTxt.status, 302);
    assert.match(llmsTxt.headers.get("location") ?? "", /\/llms\.txt$/);
  } finally {
    server.close();
  }
});

test("rejects malformed and oversized JSON request bodies", async () => {
  const { server, base } = await startTestServer();

  try {
    const malformed = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "invalid-json");

    const oversized = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jurisdiction: "US", authorityBasis: "self", padding: "x".repeat(70 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, "request-body-too-large");
  } finally {
    server.close();
  }
});

test("case lifecycle enforces approval before execution", async () => {
  const { server, base, store } = await startTestServer();

  try {
    const created = await post(base, "/api/cases", {
      jurisdiction: "US",
      authorityBasis: "self"
    }, 201);
    const caseId = created.case.id;
    const key = await createVaultKey();
    const encryptedIntake = await encryptVaultPayload(key, { email: "person@example.com" }, caseId);

    await post(base, `/api/cases/${caseId}/intake`, {
      encryptedIntake,
      redactedScope: {
        personLabel: "User",
        aliases: [],
        approvedIdentifierLabels: ["p***@example.com"],
        sensitiveConstraints: []
      }
    });
    activateTestCase(store, caseId);

    const readBack = await get(base, `/api/cases/${caseId}`);
    assert.equal(readBack.case.id, caseId);
    assert.equal(readBack.status.scope.personLabel, "User");

    const caseListBlocked = await fetch(`${base}/api/cases`);
    assert.equal(caseListBlocked.status, 401);
    assert.equal((await caseListBlocked.json()).error, "case-list-not-available");

    const proposed = await post(base, "/api/actions/propose", {
      caseId,
      actionType: "broker-opt-out",
      destination: "Example Broker",
      purpose: "Remove profile",
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: true
    }, 201);

    const blocked = await post(base, `/api/actions/${proposed.action.id}/execute`, {}, 403);
    assert.equal(blocked.error, "execution-blocked");

    await post(
      base,
      `/api/approvals/${proposed.approval.id}/approve`,
      { userConfirmation: "short" },
      422
    );

    await post(base, `/api/approvals/${proposed.approval.id}/approve`, {
      userConfirmation: "I approve this exact action"
    });

    const executed = await post(base, `/api/actions/${proposed.action.id}/execute`, {});
    assert.equal(executed.action.executionStatus, "recorded");

    const reapprove = await fetch(`${base}/api/approvals/${proposed.approval.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.accessToken}` },
      body: JSON.stringify({ userConfirmation: "I approve this exact action again" })
    });
    assert.equal(reapprove.status, 409);

    const exported = await post(base, "/api/export", { caseId });
    assert.equal(exported.case.encryptedIntake.ciphertext, encryptedIntake.ciphertext);
    assert.doesNotMatch(JSON.stringify(exported), /person@example\.com/);

    const deleted = await post(base, "/api/delete", { caseId });
    assert.equal(deleted.tombstone, true);
    await post(base, "/api/export", { caseId }, 404);
  } finally {
    server.close();
  }
});