import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Dockerfile runs the Node app on port 8080 without plaintext build secrets", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS build/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}\n\nWORKDIR/);
  assert.match(dockerfile, /npm run build:client/);
  assert.match(dockerfile, /ENV PORT=8080/);
  assert.match(dockerfile, /OBLIVION_DISABLE_PLAINTEXT_LOGS=true/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /CMD \["node", "--import", "tsx", "src\/server\.ts"\]/);
  assert.match(dockerfile, /COPY spec \.\/spec/);
  assert.doesNotMatch(dockerfile, /HIBP_API_KEY|VENICE_API_KEY|ONESHOT_API_KEY/);
});

test("docs content ships user guide pricing and legal pages", async () => {
  const overview = await readFile(
    new URL("../../docs/src/docs/content/user-guide/overview.md", import.meta.url),
    "utf8"
  );
  const pricing = await readFile(new URL("../../docs/src/docs/content/pricing.md", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../../docs/src/docs/content/legal/privacy.md", import.meta.url), "utf8");
  const terms = await readFile(new URL("../../docs/src/docs/content/legal/terms.md", import.meta.url), "utf8");
  assert.match(overview, /private cleanup agent/i);
  assert.match(pricing, /credit-starter/);
  assert.match(pricing, /credit-monitor/);
  assert.match(pricing, /\$5 USDC/);
  assert.match(pricing, /\$10 USDC\/mo/);
  assert.match(pricing, /500/);
  assert.match(pricing, /1,200/);
  assert.match(privacy, /Privacy Policy/);
  assert.match(terms, /Terms of Service/);
});

test("Phala compose template is port-aligned and digest-pinned", async () => {
  const compose = await readFile(new URL("../../docker-compose.phala.yml", import.meta.url), "utf8");

  assert.match(compose, /image: ghcr\.io\/thomasjvu\/oblivion:[0-9a-f-]+/);
  assert.doesNotMatch(compose, /image: ghcr\.io\/thomasjvu\/oblivion:latest/);
  const trustCenter = await readFile(new URL("../../config/trust-center.json", import.meta.url), "utf8");
  assert.match(trustCenter, /ghcr\.io\/thomasjvu\/oblivion@sha256:[0-9a-f]{64}/);
  assert.match(compose, /"8080:8080"/);
  assert.match(compose, /PORT=8080/);
  assert.match(compose, /PHALA_ATTESTATION_URL=https:\/\/\$\{DSTACK_APP_ID\}\.\$\{DSTACK_GATEWAY_DOMAIN\}\/tcbinfo/);
  assert.match(compose, /\/var\/run\/dstack\.sock:\/var\/run\/dstack\.sock/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /VENICE_API_KEY=\$\{VENICE_API_KEY:-\}/);
  assert.match(compose, /OBLIVION_DEPLOYMENT_ENV=production/);
  assert.doesNotMatch(compose, /OBLIVION_EXECUTOR_MODE=/);
  assert.doesNotMatch(compose, /VENICE_API_KEY=sk-|ONESHOT_API_KEY=[0-9a-f]{8}-/i);
});

test("trust center deploymentVersion matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const trustCenter = JSON.parse(await readFile(new URL("../../config/trust-center.json", import.meta.url), "utf8"));
  assert.equal(trustCenter.deploymentVersion, pkg.version);
});

