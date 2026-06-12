import { followUpDate } from "../deadlines.js";
import { walletKeyFromAddress } from "../credits.js";
import { isX402Configured, x402Network } from "../integrations.js";
import type {
  Erc7710Delegation,
  PaymentMode,
  PaymentSession,
  PermissionGrant,
  X402PaymentRequest
} from "../types.js";
import { productForMode } from "./catalog.js";

export function createPaymentSession(input: {
  caseId: string;
  mode: PaymentMode;
  productId?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}): PaymentSession {
  const product = productForMode(input.mode, input.productId);
  const expiresAt = followUpDate(product.mode === "subscription" ? 30 : 1);
  if (!isX402Configured()) {
    throw Object.assign(new Error("x402-not-configured"), {
      statusCode: 503,
      message: "Set X402_PAY_TO and X402_FACILITATOR_URL for payment sessions."
    });
  }
  if (!input.walletAddress?.startsWith("0x")) {
    throw Object.assign(new Error("wallet-address-required"), { statusCode: 422 });
  }
  const walletKey = walletKeyFromAddress(input.walletAddress);
  const x402Request: X402PaymentRequest = {
    version: "x402-v2",
    endpoint: product.x402Endpoint,
    amountUsd: product.amountUsd,
    token: product.token,
    network: x402Network(),
    memo: `${product.name} for wallet credits`,
    expiresAt
  };
  const erc7710Delegation: Erc7710Delegation = {
    standard: "ERC-7710",
    delegate: "PaymentAgent",
    endpoint: product.x402Endpoint,
    spendCapUsd: product.amountUsd,
    token: product.token,
    cadence: product.cadence,
    expiresAt,
    scope: [
      product.mode === "subscription" ? "refill-monthly-credits" : "top-up-credits",
      "x402-only",
      "wallet-bound"
    ]
  };
  validateErc7710Delegation(erc7710Delegation);
  const now = new Date().toISOString();
  return {
    id: `payment_${crypto.randomUUID()}`,
    caseId: input.caseId,
    productId: product.id,
    mode: product.mode,
    status: "payment-required",
    amountUsd: product.amountUsd,
    token: product.token,
    network: product.network,
    cadence: product.cadence,
    x402Request,
    erc7710Delegation,
    walletKey,
    walletAddress: input.walletAddress,
    smartAccountAddress: input.smartAccountAddress,
    createdAt: now,
    updatedAt: now
  };
}

export function createPaymentPermission(caseId: string, session: PaymentSession): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "erc7710-payment",
    delegate: "PaymentAgent",
    scope: session.erc7710Delegation.scope,
    spendCapUsd: session.erc7710Delegation.spendCapUsd,
    token: session.erc7710Delegation.token,
    expiresAt: session.erc7710Delegation.expiresAt,
    redelegatable: false,
    status: "granted"
  });
}

export function validateErc7710Delegation(delegation: Erc7710Delegation): void {
  if (!delegation.expiresAt || Number.isNaN(Date.parse(delegation.expiresAt))) {
    throw Object.assign(new Error("erc7710-expiration-required"), { statusCode: 422 });
  }
  if (new Date(delegation.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error("erc7710-expired"), { statusCode: 422 });
  }
  if (!Number.isFinite(delegation.spendCapUsd) || delegation.spendCapUsd <= 0 || delegation.spendCapUsd > 100) {
    throw Object.assign(new Error("erc7710-spend-cap-invalid"), { statusCode: 422 });
  }
  if (containsBroadScope(delegation.scope)) {
    throw Object.assign(new Error("erc7710-scope-too-broad"), { statusCode: 422 });
  }
}

export function validatePermissionGrant(grant: PermissionGrant): void {
  if (!grant.expiresAt || new Date(grant.expiresAt).getTime() <= Date.now()) {
    throw Object.assign(new Error("permission-expiration-required"), { statusCode: 422 });
  }
  if (containsBroadScope(grant.scope)) {
    throw Object.assign(new Error("permission-scope-too-broad"), { statusCode: 422 });
  }
  if (grant.permissionType === "erc7710-payment" && (!grant.spendCapUsd || grant.spendCapUsd <= 0)) {
    throw Object.assign(new Error("payment-permission-spend-cap-required"), { statusCode: 422 });
  }
}

export function createPermissionGrant(input: Omit<PermissionGrant, "id" | "createdAt">): PermissionGrant {
  const grant: PermissionGrant = {
    id: `permission_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  validatePermissionGrant(grant);
  return grant;
}

function containsBroadScope(scope: string[]): boolean {
  return scope.some((item) => {
    const normalized = item.toLowerCase().trim();
    return normalized === "*" || normalized === "all" || normalized.includes("unlimited") || normalized.includes("any-");
  });
}