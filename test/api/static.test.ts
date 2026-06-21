import assert from "node:assert/strict";
import test from "node:test";
import { serveStaticWithTraversalGuard } from "../../src/api/static.js";
import { startTestServer } from "../helpers/http.js";

test("serveStaticWithTraversalGuard rejects traversal paths", () => {
  assert.equal(serveStaticWithTraversalGuard("../etc/passwd"), false);
  assert.equal(serveStaticWithTraversalGuard("styles.css"), true);
  assert.equal(serveStaticWithTraversalGuard("assets/hero.webp", { allowSubdirs: true }), true);
});

test("static handler rejects traversal requests", async () => {
  const { server, base } = await startTestServer();
  try {
    const response = await fetch(`${base}/../etc/passwd`);
    assert.ok(response.status >= 400);
  } finally {
    server.close();
  }
});