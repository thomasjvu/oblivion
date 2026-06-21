import assert from "node:assert/strict";
import test from "node:test";
import type { OblivionRepository } from "../../src/storage/repository.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

const REQUIRED_METHODS: Array<keyof OblivionRepository> = [
  "getCaseOrThrow",
  "approvalsForCase",
  "actionsForCase",
  "exposuresForCase",
  "followUpsForCase",
  "paymentSessionsForCase",
  "permissionGrantsForCase",
  "relayerEventsForCase",
  "veniceAnalysesForCase",
  "agentDelegationsForCase",
  "agentMessagesForCase",
  "agentTimelineForCase",
  "agentPlanForCase",
  "connectorResultsForCase"
];

test("MemoryStore implements OblivionRepository query surface", () => {
  const store: OblivionRepository = new MemoryStore();
  for (const method of REQUIRED_METHODS) {
    assert.equal(typeof store[method], "function", `missing repository method ${method}`);
  }
});