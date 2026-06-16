import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/domain/errors.js";
import { toHttpError } from "../../src/api/errors.js";
import { HttpError } from "../../src/api/errors.js";

test("DomainError maps to HttpError via toHttpError", () => {
  const error = new DomainError("credits-insufficient", 402, { balanceCredits: 0 });
  const http = toHttpError(error);
  assert.ok(http instanceof HttpError);
  assert.equal(http.statusCode, 402);
  assert.equal(http.message, "credits-insufficient");
  assert.deepEqual(http.details, { balanceCredits: 0 });
});