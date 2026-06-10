import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerPath = new URL("../../workers/src/index.ts", import.meta.url);
const wranglerPath = new URL("../../workers/wrangler.toml", import.meta.url);

test("cloudflare worker proxies /api to configured backend", async () => {
  const source = await readFile(workerPath, "utf8");
  const wrangler = await readFile(wranglerPath, "utf8");

  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /proxyApiRequest/);
  assert.match(wrangler, /run_worker_first = true/);
});