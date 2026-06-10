const CASE_TOKENS_KEY = "oblivion.caseTokens";

let cachedApiOrigin = null;
let caseTokensCache = null;

export function loadCaseTokens() {
  if (caseTokensCache) return caseTokensCache;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CASE_TOKENS_KEY) : null;
    caseTokensCache = raw ? JSON.parse(raw) : {};
  } catch {
    caseTokensCache = {};
  }
  return caseTokensCache;
}

export function saveCaseTokens() {
  if (!caseTokensCache || typeof localStorage === "undefined") return;
  localStorage.setItem(CASE_TOKENS_KEY, JSON.stringify(caseTokensCache));
}

export function getCaseToken(caseId) {
  if (!caseId) return undefined;
  return loadCaseTokens()[caseId];
}

export function setCaseToken(caseId, token) {
  if (!caseId || !token) return;
  loadCaseTokens()[caseId] = token;
  saveCaseTokens();
}

export function removeCaseToken(caseId) {
  if (!caseId) return;
  loadCaseTokens();
  delete caseTokensCache[caseId];
  saveCaseTokens();
}

function caseIdFromPath(path) {
  const match = String(path).match(/^\/api\/cases\/([^/]+)/);
  return match?.[1];
}

function authHeadersForRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let caseId = caseIdFromPath(path);
  if (!caseId && options.body && typeof options.body === "object" && options.body.caseId) {
    caseId = options.body.caseId;
  }
  if (caseId) {
    const token = getCaseToken(caseId);
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export function apiOrigin() {
  if (cachedApiOrigin !== null) return cachedApiOrigin;
  const configured = typeof window !== "undefined" ? window.OBLIVION_API_ORIGIN : "";
  cachedApiOrigin = typeof configured === "string" && configured.trim() ? configured.trim().replace(/\/$/, "") : "";
  return cachedApiOrigin;
}

export function apiUrl(path) {
  const origin = apiOrigin();
  if (!origin) return path;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiRequest(path, options = {}) {
  const headers = options.body
    ? { "content-type": "application/json", ...authHeadersForRequest(path, options) }
    : authHeadersForRequest(path, options);
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const raw = await response.text();
  let json = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw {
        error: "invalid-json",
        message: `Server returned an invalid response (${response.status}).`
      };
    }
  } else if (!response.ok) {
    throw {
      error: "empty-response",
      message: `Request failed (${response.status}). Check that the API is reachable.`
    };
  }
  if (!response.ok) throw json;
  return json;
}

export async function loadApiConfig() {
  try {
    const config = await apiRequest("/api/config");
    if (config.apiOrigin && !window.OBLIVION_API_ORIGIN) {
      cachedApiOrigin = String(config.apiOrigin).replace(/\/$/, "");
    }
    return config;
  } catch {
    return null;
  }
}