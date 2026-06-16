// @ts-nocheck — runtime tests for plain JS client modules.
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    }
  },
  configurable: true
});

const { getCaseToken, setCaseToken, removeCaseToken, loadCaseTokens } = await import("../../public/src/apiClient.js");

test("case token round-trip via localStorage", () => {
  storage.clear();
  setCaseToken("case_a", "token_a");
  assert.equal(getCaseToken("case_a"), "token_a");
  assert.equal(loadCaseTokens().case_a, "token_a");
  removeCaseToken("case_a");
  assert.equal(getCaseToken("case_a"), undefined);
});

test("setCaseToken ignores empty inputs", () => {
  storage.clear();
  setCaseToken("", "token");
  setCaseToken("case_b", "");
  assert.deepEqual(loadCaseTokens(), {});
});