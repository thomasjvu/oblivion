import { followUpDate } from "./deadlines.js";
import { DomainError } from "./errors.js";
import { walletLiveMode } from "./integrations.js";
import { isEvmAddress } from "./constants.js";
import { createPermissionGrant } from "./payments/sessions.js";
import type { PermissionGrant } from "./types.js";

export function resolveSmartAccountAddress(input: {
  walletAddress: string;
  smartAccountAddress?: string;
}): string {
  if (isEvmAddress(input.smartAccountAddress)) {
    return input.smartAccountAddress;
  }
  if (walletLiveMode() && isEvmAddress(input.walletAddress)) {
    return input.walletAddress;
  }
  throw new DomainError("smart-account-address-required", 422);
}

export function createEip7702Authorization(
  caseId: string,
  walletAddress: string,
  smartAccountAddress?: string
): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "eip7702-authorization",
    delegate: smartAccountAddress ?? walletAddress,
    scope: ["upgrade-wallet-to-smart-account", "display-smart-account-session"],
    expiresAt: followUpDate(30),
    redelegatable: false,
    status: "granted"
  });
}

export function createErc7715Permission(caseId: string, delegate = "OblivionRoot"): PermissionGrant {
  return createPermissionGrant({
    caseId,
    permissionType: "erc7715-advanced",
    delegate,
    scope: [
      "propose-redacted-cleanup-tasks",
      "request-per-action-approval",
      "redelegate-minimum-agent-capabilities"
    ],
    expiresAt: followUpDate(14),
    redelegatable: true,
    status: "granted"
  });
}