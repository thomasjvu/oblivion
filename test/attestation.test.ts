import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildAttestationProof,
  extractComposeHash,
  quoteToHex,
  validateImageDigests
} from "../src/domain/attestation.js";

test("rejects tag-based image references", () => {
  assert.deepEqual(validateImageDigests(["ghcr.io/example/oblivion:latest"]), [
    "image-not-pinned:ghcr.io/example/oblivion:latest"
  ]);
});

test("accepts sha256 pinned image references", () => {
  const digest = "ghcr.io/example/oblivion@sha256:" + "a".repeat(64);
  assert.deepEqual(validateImageDigests([digest]), []);
});

test("marks placeholder trust config as not configured", async () => {
  const proof = await buildAttestationProof({
    deploymentVersion: "0.1.0",
    sourceCommit: "local",
    expectedComposeHash: "replace-with-live-hash",
    imageDigests: ["ghcr.io/example/oblivion@sha256:" + "a".repeat(64)],
    attestationReport: null,
    verificationInstructions: []
  });

  assert.equal(proof.verifierResult, "not-configured");
  assert.equal(proof.imageDigestsPinned, true);
});

test("extracts compose hash from Phala-style report", () => {
  const appCompose = JSON.stringify({ docker_compose_file: "services:\n  oblivion:\n    image: x@sha256:y" });
  const report = { info: { tcb_info: { app_compose: appCompose } } };
  assert.equal(extractComposeHash(report), createHash("sha256").update(appCompose).digest("hex"));
});

test("extracts compose hash from compose_hash field", () => {
  const hash = "b".repeat(64);
  assert.equal(extractComposeHash({ compose_hash: hash }), hash);
});

test("converts base64 quote to hex", () => {
  assert.equal(quoteToHex(Buffer.from("abc").toString("base64")), "616263");
});

test("passes when live attestation and compose hash match", async () => {
  const originalFetch = globalThis.fetch;
  const appCompose = JSON.stringify({ docker_compose_file: "services:\n  oblivion:\n    image: x@sha256:y" });
  const expectedComposeHash = createHash("sha256").update(appCompose).digest("hex");
  const report = {
    intel_quote: Buffer.from("fake-quote").toString("base64"),
    info: { tcb_info: { app_compose: appCompose } }
  };

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("attestation.local")) {
      return Response.json(report);
    }
    assert.equal(init?.method, "POST");
    return Response.json({ quote: { verified: true } });
  }) as typeof fetch;

  try {
    const proof = await buildAttestationProof({
      deploymentVersion: "0.1.0",
      sourceCommit: "abc123",
      expectedComposeHash,
      imageDigests: ["ghcr.io/example/oblivion@sha256:" + "a".repeat(64)],
      attestationReportUrl: "https://attestation.local/report",
      verificationInstructions: []
    }, { fetchLive: true });

    assert.equal(proof.verifierResult, "pass");
    assert.equal(proof.composeHashMatches, true);
    assert.equal(proof.hardwareQuoteVerified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
