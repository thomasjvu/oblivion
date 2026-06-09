import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../../src/api/app.js";
import { activateCaseForTest } from "../../src/domain/caseActivation.js";
import type { Jurisdiction, RiskLevel } from "../../src/domain/types.js";
import type { MemoryStore } from "../../src/storage/memoryStore.js";

const caseTokens = new Map<string, string>();
const approvalCases = new Map<string, string>();
const actionCases = new Map<string, string>();

function caseIdFromRequest(path: string, body?: unknown): string | undefined {
  const url = new URL(path, "http://test");
  const queryCaseId = url.searchParams.get("caseId");
  if (queryCaseId) return queryCaseId;

  const caseMatch = url.pathname.match(/^\/api\/cases\/([^/]+)/);
  if (caseMatch) return caseMatch[1];

  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (approvalMatch) return approvalCases.get(approvalMatch[1]);

  const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
  if (actionMatch) return actionCases.get(actionMatch[1]);

  if (body && typeof body === "object" && body !== null && "caseId" in body) {
    return String((body as { caseId: string }).caseId);
  }
  return undefined;
}

function authHeaders(path: string, body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  const caseId = caseIdFromRequest(path, body);
  if (caseId) {
    const token = caseTokens.get(caseId);
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function rememberApprovalAndAction(json: any) {
  if (json?.approval?.id && json?.approval?.caseId) {
    approvalCases.set(json.approval.id, json.approval.caseId);
  }
  if (json?.action?.id && json?.action?.caseId) {
    actionCases.set(json.action.id, json.action.caseId);
  }
  if (json?.status?.approvalsNeeded) {
    for (const approval of json.status.approvalsNeeded) {
      if (approval?.id && approval?.caseId) approvalCases.set(approval.id, approval.caseId);
    }
  }
}

function rememberCaseToken(caseId: string, token: string | undefined) {
  if (caseId && token) caseTokens.set(caseId, token);
}

export function setCaseToken(caseId: string, token: string) {
  rememberCaseToken(caseId, token);
}

export function clearCaseToken(caseId: string) {
  caseTokens.delete(caseId);
}

export async function startTestServer(): Promise<{ server: Server; base: string; store: MemoryStore }> {
  const { server, store } = createApp();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  return { server, base, store };
}

export function activateTestCase(store: MemoryStore, caseId: string): void {
  activateCaseForTest(store, caseId);
}

export async function get(base: string, path: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    headers: authHeaders(path)
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  rememberApprovalAndAction(json);
  return json;
}

export async function post(base: string, path: string, body: unknown, expectedStatus = 200): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(path, body) },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(json));
  if (path === "/api/cases" && expectedStatus === 201 && json.case?.id && json.accessToken) {
    rememberCaseToken(json.case.id, json.accessToken);
  }
  rememberApprovalAndAction(json);
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
  riskLevel: RiskLevel = "standard",
  store?: MemoryStore
): Promise<{ caseId: string; accessToken: string }> {
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
  if (store) activateCaseForTest(store, created.case.id);
  return { caseId: created.case.id, accessToken: created.accessToken as string };
}

export async function runUntilApproval(base: string, caseId: string) {
  for (let index = 0; index < 10; index += 1) {
    const current = await get(base, `/api/cases/${caseId}`);
    if (current.status.approvalsNeeded.length > 0) return;
    await post(base, "/api/agent/run-next", { caseId });
  }
}