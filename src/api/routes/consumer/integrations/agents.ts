import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAgentRun } from "../../../handlers/agentRun.js";
import { meterVeniceChat } from "../../../handlers/veniceMeter.js";
import { createAgentDelegationSet, pendingHackathonTracks } from "../../../../domain/hackathon.js";
import { buildAgentNextStep, buildHackathonStatusForCase } from "../../../../domain/orchestration.js";
import { redactText } from "../../../../domain/redaction.js";
import { assertCaseActivated } from "../../../../domain/caseActivation.js";
import { getCaseWithAccess } from "../../../auth.js";
import { HttpError } from "../../../errors.js";
import { readJson, sendJson } from "../../../http.js";
import {
  type AgentDelegateBody,
  type AgentMessageBody,
  type AgentRunBody,
  type ConsumerContext,
  parseAgentName
} from "../context.js";

export async function handleIntegrationAgentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConsumerContext
): Promise<boolean> {
  const { store, trustCenterPath } = context;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/agent/next") {
    const caseId = url.searchParams.get("caseId");
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, buildAgentNextStep(store, caseId));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agent/chat") {
    const body = await readJson<{ caseId: string; message: string; walletAddress?: string }>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.message?.trim()) throw new HttpError(422, "agent-message-required");
    const result = await meterVeniceChat(store, caseRecord, {
      message: body.message,
      walletAddress: body.walletAddress
    });
    sendJson(response, 200, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agent/run-next") {
    const body = await readJson<AgentRunBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    assertCaseActivated(store, caseRecord);
    const result = await handleAgentRun(store, caseRecord, trustCenterPath);
    sendJson(response, 200, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agents/delegate") {
    const body = await readJson<AgentDelegateBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    const result = createAgentDelegationSet(caseRecord.id);
    result.grants.forEach((grant) => store.permissionGrants.set(grant.id, grant));
    result.delegations.forEach((delegation) => store.agentDelegations.set(delegation.id, delegation));
    result.messages.forEach((message) => store.agentMessages.set(message.id, message));
    result.timeline.forEach((event) => store.agentTimeline.set(event.id, event));
    sendJson(response, 201, result);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/agents/message") {
    const body = await readJson<AgentMessageBody>(request);
    const caseRecord = getCaseWithAccess(request, store, body.caseId);
    if (!body.purpose) throw new HttpError(422, "message-purpose-required");
    const fromAgent = parseAgentName(body.fromAgent ?? "OblivionRoot");
    const toAgent = parseAgentName(body.toAgent ?? "VerifierAgent");
    const message = {
      id: `agent_msg_${crypto.randomUUID()}`,
      caseId: caseRecord.id,
      fromAgent,
      toAgent,
      purpose: redactText(body.purpose),
      redactedPayload: redactText(body.payload ?? ""),
      createdAt: new Date().toISOString()
    };
    store.agentMessages.set(message.id, message);
    sendJson(response, 201, { message });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/agents/timeline") {
    const caseId = url.searchParams.get("caseId");
    if (!caseId) throw new HttpError(422, "case-id-required");
    getCaseWithAccess(request, store, caseId);
    sendJson(response, 200, {
      permissions: store.permissionGrantsForCase(caseId),
      payments: store.paymentSessionsForCase(caseId),
      relayerEvents: store.relayerEventsForCase(caseId),
      veniceAnalyses: store.veniceAnalysesForCase(caseId),
      delegations: store.agentDelegationsForCase(caseId),
      messages: store.agentMessagesForCase(caseId),
      timeline: store.agentTimelineForCase(caseId)
    });
    return true;
  }

  if (process.env.HACKATHON_MODE === "true") {
    if (method === "GET" && url.pathname === "/api/hackathon/status") {
      const caseId = url.searchParams.get("caseId");
      if (!caseId) throw new HttpError(422, "case-id-required");
      getCaseWithAccess(request, store, caseId);
      const walletAddress = url.searchParams.get("walletAddress") ?? undefined;
      const status = buildHackathonStatusForCase(store, caseId, walletAddress);
      sendJson(response, 200, {
        status,
        pending: pendingHackathonTracks(status)
      });
      return true;
    }
  }

  return false;
}