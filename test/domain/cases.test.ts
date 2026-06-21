import assert from "node:assert/strict";
import test from "node:test";
import { createCaseRecord } from "../../src/domain/cases.js";

test("createCaseRecord rejects non-HTTPS callback URLs", () => {
  assert.throws(
    () =>
      createCaseRecord({
        jurisdiction: "US",
        authorityBasis: "self",
        partnerId: "partner_1",
        callbackUrl: "http://insecure.example/cb"
      }),
    (error: unknown) => error instanceof Error && error.message === "callback-url-https-required"
  );
});