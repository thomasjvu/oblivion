import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { encryptVaultPayload, createVaultKey } from "../src/crypto/clientVault.js";

test("serves split frontend assets with restrictive security headers", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(html.headers.get("x-frame-options"), "DENY");
    assert.equal(html.headers.get("referrer-policy"), "no-referrer");

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /\/fonts\/Compass\.ttf/);

    const font = await fetch(`${base}/fonts/Compass.ttf`);
    assert.equal(font.status, 200);
    assert.match(font.headers.get("content-type") ?? "", /font\/ttf/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /application\/javascript/);

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

    const favicon = await fetch(`${base}/favicon.svg`);
    assert.equal(favicon.status, 200);

    const help = await fetch(`${base}/help`);
    assert.equal(help.status, 200);
    assert.match(help.headers.get("content-type") ?? "", /text\/html/);
    const helpHtml = await help.text();
    assert.match(helpHtml, /Step 1 — Tell the agent/);
    assert.match(helpHtml, /<strong>private cleanup agent<\/strong>/);
    assert.doesNotMatch(helpHtml, /\*\*private cleanup agent\*\*/);
  } finally {
    server.close();
  }
});

test("rejects malformed and oversized JSON request bodies", async () => {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

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
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;

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

    const readBack = await get(base, `/api/cases/${caseId}`);
    assert.equal(readBack.case.id, caseId);
    assert.equal(readBack.status.scope.personLabel, "User");

    const caseList = await get(base, "/api/cases");
    assert.equal(caseList.cases.length, 1);
    assert.equal(caseList.cases[0].id, caseId);

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

    await post(base, `/api/approvals/${proposed.approval.id}/approve`, {
      userConfirmation: "I approve this exact action"
    });

    const executed = await post(base, `/api/actions/${proposed.action.id}/execute`, {});
    assert.equal(executed.action.executionStatus, "recorded");

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

async function get(base: string, path: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}

async function post(base: string, path: string, body: unknown, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}
