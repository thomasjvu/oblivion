import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSensitiveExecutionAllowed,
  runtimeModeFromProof
} from "../../src/domain/runtimeGuard.js";

test("runtimeModeFromProof maps verifier results", () => {
  assert.equal(runtimeModeFromProof({ verifierResult: "pass" }), "tee-verified");
  assert.equal(runtimeModeFromProof({ verifierResult: "fail" }), "tee-blocked");
  assert.equal(runtimeModeFromProof({ verifierResult: "not-configured" }), "local");
});

test("assertSensitiveExecutionAllowed allows localSafe shortcuts", () => {
  assert.doesNotThrow(() =>
    assertSensitiveExecutionAllowed({
      proof: { verifierResult: "fail" },
      requiresManagedPlaintext: true,
      localSafe: true
    })
  );
});

test("assertSensitiveExecutionAllowed blocks managed plaintext without TEE pass", () => {
  assert.throws(
    () =>
      assertSensitiveExecutionAllowed({
        proof: { verifierResult: "not-configured" },
        requiresManagedPlaintext: true,
        localSafe: false
      }),
    (error: Error) => error.message === "runtime-not-tee-verified"
  );
});

test("assertSensitiveExecutionAllowed allows managed plaintext after TEE pass", () => {
  assert.doesNotThrow(() =>
    assertSensitiveExecutionAllowed({
      proof: { verifierResult: "pass" },
      requiresManagedPlaintext: true,
      localSafe: false
    })
  );
});