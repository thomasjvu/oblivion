let cachedApiOrigin = null;

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
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
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