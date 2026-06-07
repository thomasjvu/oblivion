import test from "node:test";
import assert from "node:assert/strict";
import { relayerEventFromOneShotWebhook } from "../../src/domain/oneshotWebhook.js";

test("relayerEventFromOneShotWebhook maps TransactionExecutionSuccess payload", () => {
  const event = relayerEventFromOneShotWebhook({
    caseId: "case_webhook",
    sessionId: "payment_1",
    payload: {
      eventName: "TransactionExecutionSuccess",
      data: {
        transactionExecutionId: "task_abc",
        transactionReceipt: {
          hash: "0xdeadbeef",
          status: 1
        },
        transactionExecutionMemo: JSON.stringify({ caseId: "case_webhook", sessionId: "payment_1" })
      }
    }
  });
  assert.equal(event.status, "confirmed");
  assert.equal(event.taskId, "task_abc");
  assert.equal(event.txHash, "0xdeadbeef");
});