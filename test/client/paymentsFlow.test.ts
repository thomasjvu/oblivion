// @ts-nocheck — runtime tests for plain JS client modules.
import test from "node:test";
import assert from "node:assert/strict";
const { caseIsActivated } = await import("../../public/src/paymentsFlow.js");

test("caseIsActivated trusts server currentStatus.activated only", () => {
  assert.equal(caseIsActivated({ currentStatus: { activated: true } }), true);
  assert.equal(caseIsActivated({ currentStatus: { activated: false } }), false);
  assert.equal(caseIsActivated({ currentStatus: {} }), false);
  assert.equal(
    caseIsActivated({
      currentStatus: { activated: false },
      agentContext: { payments: [{ mode: "one-off", status: "paid" }] },
      selectedPaymentMode: "one-off"
    }),
    false
  );
});