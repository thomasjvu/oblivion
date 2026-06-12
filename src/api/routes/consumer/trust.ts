import type { IncomingMessage, ServerResponse } from "node:http";
import { buildAttestationProof } from "../../../domain/attestation.js";
import { sendJson } from "../../http.js";
import type { ConsumerContext } from "./context.js";

export async function handleConsumerTrustRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { loadTrustCenterConfig } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/trust/attestation") {
    const config = await loadTrustCenterConfig();
    const fetchLive = url.searchParams.get("live") !== "0";
    sendJson(response, 200, await buildAttestationProof(config, { fetchLive }));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/trust/privacy") {
    sendJson(response, 200, {
      storedPlaintext: false,
      serverCanDecryptCaseVault: false,
      rawPiiToNonTeeLlm: false,
      defaultExecutor: "record-only",
      sensitiveActionRequiresApproval: true,
      thirdPartyDisclosureStillPossible: true,
      message:
        "Stored case data is ciphertext. Approved actions may disclose approved identifiers to named third parties, and sensitive plaintext should only be decrypted in the browser or an attested TEE task."
    });
    return true;
  }

  return false;
}