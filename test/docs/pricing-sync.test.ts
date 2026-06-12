import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CREDITS_PER_100_TOKENS,
  EMAIL_RELAY_CREDITS,
  MONITOR_MONTHLY_CREDITS,
  STARTER_PACK_CREDITS
} from "../../src/domain/credits.js";
import { X402_PRODUCTS } from "../../src/domain/payments/catalog.js";

const pricingPath = join(process.cwd(), "docs/src/docs/content/pricing.md");
const pricing = readFileSync(pricingPath, "utf8");

test("pricing.md documents wallet credit products from code", () => {
  for (const product of X402_PRODUCTS) {
    assert.match(pricing, new RegExp(product.id));
    assert.match(pricing, new RegExp(String(product.amountUsd)));
  }

  assert.match(pricing, new RegExp(String(STARTER_PACK_CREDITS)));
  assert.match(pricing, new RegExp(String(MONITOR_MONTHLY_CREDITS)));
  assert.match(pricing, new RegExp(String(EMAIL_RELAY_CREDITS)));
  assert.match(pricing, new RegExp(String(CREDITS_PER_100_TOKENS)));
});

test("pricing.md does not document deprecated per-plan chat caps", () => {
  assert.doesNotMatch(pricing, /Agent chats/i);
  assert.doesNotMatch(pricing, /AI analysis tasks/i);
  assert.doesNotMatch(pricing, /\|\s*5\s*\|\s*30\s*\|/);
});