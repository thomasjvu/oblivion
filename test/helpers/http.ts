import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../../src/api/app.js";
import type { Jurisdiction, RiskLevel } from "../../src/domain/types.js";

export async function startTestServer(): Promise<{ server: Server; base: string }> {
  const { server } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  return { server, base };
}

export async function get(base: string, path: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`);
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}

export async function post(base: string, path: string, body: unknown, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  return json;
}

export function encryptedBlob(aad: string) {
  return {
    alg: "AES-256-GCM",
    keyId: "test-key",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "BBBBBBBBBBBBBBBB",
    aad
  };
}

export async function createCaseWithIntake(
  base: string,
  jurisdiction: Jurisdiction,
  riskLevel: RiskLevel = "standard"
): Promise<{ caseId: string }> {
  const created = await post(
    base,
    "/api/cases",
    {
      jurisdiction,
      authorityBasis: "self",
      riskLevel
    },
    201
  );
  await post(base, `/api/cases/${created.case.id}/intake`, {
    encryptedIntake: encryptedBlob(created.case.id),
    redactedScope: {
      personLabel: "A.B.",
      aliases: [],
      approvedIdentifierLabels: ["email"],
      sensitiveConstraints: []
    }
  });
  return { caseId: created.case.id };
}

export async function runUntilApproval(base: string, caseId: string) {
  for (let index = 0; index < 10; index += 1) {
    const current = await get(base, `/api/cases/${caseId}`);
    if (current.status.approvalsNeeded.length > 0) return;
    await post(base, "/api/agent/run-next", { caseId });
  }
}