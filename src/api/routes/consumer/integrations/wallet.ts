import type { IncomingMessage, ServerResponse } from "node:http";
import { createTimelineEvent } from "../../../../domain/agentTimeline.js";
import {
  createEip7702Authorization,
  createErc7715Permission,
  resolveSmartAccountAddress
} from "../../../../domain/hackathon.js";
import { redactText } from "../../../../domain/redaction.js";
import { deploymentEnvironment, deploymentProfile, walletChainConfig } from "../../../../domain/deploymentEnv.js";
import { getCaseWithAccess } from "../../../auth.js";
import { HttpError } from "../../../errors.js";
import { readJson, sendJson } from "../../../http.js";
import { type ConsumerContext, type SmartAccountBody } from "../context.js";

export async function handleIntegrationWalletRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/integrations/wallet-config") {
    const chain = walletChainConfig();
    const liveEnabled = process.env.WALLET_LIVE_MODE === "true";
    const profile = deploymentProfile();
    sendJson(response, 200, {
      mode: liveEnabled ? "live" : "demo",
      liveEnabled,
      environment: deploymentEnvironment(),
      environmentLabel: profile.label,
      chainId: chain.chainId,
      chainIdHex: chain.chainIdHex,
      addChainParams: chain.addChainParams,
      poll: { attempts: 12, delayMs: 1500 }
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/metamask/smart-account-session") {
    const body = await readJson<SmartAccountBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.walletAddress || !body.walletAddress.startsWith("0x")) {
      throw new HttpError(422, "wallet-address-required");
    }
    if (process.env.WALLET_LIVE_MODE !== "true") {
      throw new HttpError(503, "smart-account-live-required");
    }
    const smartAccountAddress = resolveSmartAccountAddress({
      walletAddress: body.walletAddress,
      smartAccountAddress: body.smartAccountAddress
    });
    const eip7702 = createEip7702Authorization(caseRecord.id, body.walletAddress, smartAccountAddress);
    const erc7715 = createErc7715Permission(caseRecord.id);
    store.permissionGrants.set(eip7702.id, eip7702);
    store.permissionGrants.set(erc7715.id, erc7715);
    const smartDetail = `EIP-7702 authorization recorded after MetaMask batch${body.txHash ? ` (${body.txHash.slice(0, 10)}…)` : ""}.`;
    const timeline = [
      createTimelineEvent(caseRecord.id, "MetaMask", "Smart Account session", smartDetail),
      createTimelineEvent(
        caseRecord.id,
        "MetaMask",
        "ERC-7715 permission",
        "Advanced permission grants only task proposal, approval request, and narrow redelegation."
      )
    ];
    timeline.forEach((event) => store.agentTimeline.set(event.id, event));
    sendJson(response, 201, {
      mode: "live",
      walletAddress: redactText(body.walletAddress),
      smartAccountAddress,
      txHash: body.txHash,
      callsId: body.callsId,
      chainId: body.chainId,
      permissions: [eip7702, erc7715],
      timeline
    });
    return true;
  }

  return false;
}