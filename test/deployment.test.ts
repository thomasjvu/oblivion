import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Dockerfile runs the Node app on port 8080 without plaintext build secrets", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /FROM node:22/);
  assert.match(dockerfile, /ENV PORT=8080/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /CMD \["node", "--import", "tsx", "src\/server\.ts"\]/);
  assert.match(dockerfile, /COPY docs \.\/docs/);
  assert.doesNotMatch(dockerfile, /HIBP_API_KEY|VENICE_API_KEY|ONESHOT_API_KEY/);
});

test("built legal pages ship in public for /privacy, /terms, and /pricing routes", async () => {
  const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");
  const terms = await readFile(new URL("../public/terms.html", import.meta.url), "utf8");
  const pricing = await readFile(new URL("../public/pricing.html", import.meta.url), "utf8");
  assert.match(privacy, /Privacy Policy/);
  assert.match(terms, /Terms of Service/);
  assert.match(pricing, /pricing-page/);
  assert.match(pricing, /\$5 USDC/);
  assert.match(pricing, /\$10 USDC\/mo/);
});

test("Phala compose template is port-aligned and digest-pinned", async () => {
  const compose = await readFile(new URL("../docker-compose.phala.yml", import.meta.url), "utf8");

  assert.match(compose, /image: ghcr\.io\/thomasjvu\/oblivion@sha256:[0-9a-f]{64}/);
  assert.match(compose, /"8080:8080"/);
  assert.match(compose, /PORT=8080/);
  assert.match(compose, /PHALA_ATTESTATION_URL=\$\{PHALA_ATTESTATION_URL\}/);
  assert.match(compose, /\/var\/run\/dstack\.sock:\/var\/run\/dstack\.sock/);
  assert.doesNotMatch(compose, /HIBP_API_KEY=.+|VENICE_API_KEY=.+|ONESHOT_API_KEY=.+/);
});

