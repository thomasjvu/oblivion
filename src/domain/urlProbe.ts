import { safeOutboundFetch } from "./safeOutboundUrl.js";

export async function probeOfficialUrl(url: string): Promise<{ reachable: boolean; status?: number }> {
  const headers = { "user-agent": "oblivion-privacy-agent" };
  try {
    const head = await safeOutboundFetch(url, { method: "HEAD", headers });
    if (head.ok || head.status < 500) return { reachable: true, status: head.status };
  } catch {
    // fall through to GET
  }
  try {
    const get = await safeOutboundFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8000)
    });
    return { reachable: get.ok || get.status < 500, status: get.status };
  } catch {
    return { reachable: false };
  }
}