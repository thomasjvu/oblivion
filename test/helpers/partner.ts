import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../../src/api/app.js";
import { hashPartnerApiKey } from "../../src/domain/partners.js";
import type { PartnerRecord } from "../../src/domain/types.js";

export const DEFAULT_TEST_KEY = "obl_test_partner_secret";
export const DEFAULT_TEST_PARTNER_ID = "testpartner";

export function seedTestPartner(
  store: ReturnType<typeof createApp>["store"],
  options: { id?: string; key?: string; name?: string; balanceCredits?: number } = {}
) {
  const now = new Date().toISOString();
  const partner: PartnerRecord = {
    id: options.id ?? DEFAULT_TEST_PARTNER_ID,
    name: options.name ?? "Test Partner",
    apiKeyHash: hashPartnerApiKey(options.key ?? DEFAULT_TEST_KEY),
    environment: "production",
    balanceCredits: options.balanceCredits ?? 500,
    webhookEvents: [
      "case.created",
      "approval.pending",
      "action.executed",
      "recheck.due",
      "case.completed",
      "case.deleted"
    ],
    createdAt: now,
    updatedAt: now
  };
  store.partners.set(partner.id, partner);
}

export async function partnerFetch(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; expectedStatus?: number; apiKey?: string } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.apiKey ?? DEFAULT_TEST_KEY}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if (options.expectedStatus) assert.equal(response.status, options.expectedStatus, JSON.stringify(json));
  return { response, json };
}

export async function startPartnerServer(
  options: { id?: string; key?: string; name?: string; balanceCredits?: number } = {}
): Promise<{ server: Server; store: ReturnType<typeof createApp>["store"]; base: string }> {
  const { server, store } = createApp();
  seedTestPartner(store, options);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  return { server, store, base };
}