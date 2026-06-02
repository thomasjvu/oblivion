import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const htmlPath = new URL("../public/index.html", import.meta.url);

test("initial homepage is guided and not a dense dashboard", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /id="landing-region"/);
  assert.match(html, /Clean up your online identity privately/);
  assert.match(html, /class="hero-image"/);
  assert.match(html, /id="app-workspace"/);
  assert.match(html, /\.workspace-shell\s*\{[^}]*display:\s*none/s);
  assert.match(html, /id="onboarding-region"/);
  assert.match(html, /One private case/);
  assert.match(html, /id="dashboard-region"/);
  assert.match(html, /\.dashboard\s*\{[^}]*display:\s*none/s);
  assert.match(html, /Step 1 of 5/);
});

test("advanced and noisy sections are collapsed by default", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /<details>[\s\S]*Advanced case settings/);
  assert.match(html, /<details data-advanced="trust">/);
  assert.match(html, /<details data-advanced="log">/);
  assert.doesNotMatch(html, /<pre id="output">Ready\.<\/pre>\s*<\/div>\s*<\/aside>\s*<\/div>\s*<\/section>\s*<\/main>/);
});

test("compact trust indicators remain visible on first viewport", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /id="trust-strip"/);
  assert.match(html, /Vault encrypted/);
  assert.match(html, /Server cannot decrypt/);
  assert.match(html, /TEE checking/);
});

test("landing page explains privacy and agent workflow", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /Encrypted case/);
  assert.match(html, /Verifiable runtime/);
  assert.match(html, /Approval queue/);
  assert.match(html, /Stored case data stays ciphertext/);
  assert.match(html, /Review every disclosure/);
});

test("landing page includes placeholder visual assets", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /Placeholder product image showing an encrypted case dashboard/);
  assert.match(html, /Placeholder image for encrypted case setup/);
  assert.match(html, /Placeholder image for verifiable runtime proof/);
  assert.match(html, /Placeholder image for approval queue/);
});

test("app exposes hackathon sponsor-track workflow panels", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /Connect MetaMask/);
  assert.match(html, /Create Smart Account/);
  assert.match(html, /x402/);
  assert.match(html, /ERC-7710/);
  assert.match(html, /ERC-7715/);
  assert.match(html, /Venice classify/);
  assert.match(html, />Network</);
  assert.match(html, /A2A redelegation/);
  assert.match(html, /1Shot relayer status/);
  assert.match(html, /id="hackathon-checklist"/);
});

test("dashboard uses an agentic chat command center", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /<h3>Oblivion<\/h3>/);
  assert.match(html, /id="agent-chat-log"/);
  assert.match(html, /Message Oblivion/);
  assert.match(html, /Run cleanup/);
  assert.match(html, />Next</);
  assert.match(html, />Proof</);
  assert.match(html, /id="ops-strip"/);
  assert.match(html, /id="agent-context"/);
  assert.match(html, /Approve exact action/);
  assert.match(html, /Approval required\. Review the card/);
  assert.match(html, /\/api\/agent\/run-next/);
  assert.match(html, /\/api\/agent\/next/);
});
