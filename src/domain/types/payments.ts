export type PaymentMode = "one-off" | "subscription";
export type PaymentStatus = "payment-required" | "authorized" | "paid" | "failed";

export interface PaymentProduct {
  id: string;
  name: string;
  mode: PaymentMode;
  description: string;
  amountUsd: number;
  token: "USDC";
  network: "base" | "ethereum";
  cadence?: "weekly" | "monthly";
  x402Endpoint: string;
  requiredPermission: "erc7710-payment";
}

export interface X402PaymentRequest {
  version: "x402-v2";
  endpoint: string;
  amountUsd: number;
  token: string;
  network: string;
  memo: string;
  expiresAt: string;
}

export interface Erc7710Delegation {
  standard: "ERC-7710";
  delegate: string;
  endpoint: string;
  spendCapUsd: number;
  token: string;
  cadence?: "weekly" | "monthly";
  expiresAt: string;
  scope: string[];
}

export interface PaymentSession {
  id: string;
  caseId: string;
  productId: string;
  mode: PaymentMode;
  status: PaymentStatus;
  amountUsd: number;
  token: string;
  network: string;
  cadence?: "weekly" | "monthly";
  x402Request: X402PaymentRequest;
  erc7710Delegation: Erc7710Delegation;
  walletKey?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
  relayerTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionType =
  | "eip7702-authorization"
  | "erc7715-advanced"
  | "erc7710-payment"
  | "redelegation";

export type PermissionStatus = "proposed" | "granted" | "revoked" | "expired";

export interface PermissionGrant {
  id: string;
  caseId: string;
  permissionType: PermissionType;
  delegate: string;
  scope: string[];
  spendCapUsd?: number;
  token?: string;
  expiresAt: string;
  redelegatable: boolean;
  status: PermissionStatus;
  createdAt: string;
}

export type RelayerStatus = "submitted" | "relayed" | "confirmed" | "failed";

export interface RelayerEvent {
  id: string;
  caseId: string;
  provider: "1shot";
  eventType: RelayerStatus;
  status: RelayerStatus;
  taskId?: string;
  txHash?: string;
  userOpHash?: string;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export type CreditLedgerKind = "purchase" | "token" | "email" | "discovery" | "subscription-refill";

export interface CreditAccount {
  id: string;
  walletKey: string;
  balanceCredits: number;
  subscriptionExpiresAt?: string;
  updatedAt: string;
}

export interface CreditLedgerEntry {
  id: string;
  walletKey: string;
  caseId?: string;
  kind: CreditLedgerKind;
  credits: number;
  subscriptionExpiresAt?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}