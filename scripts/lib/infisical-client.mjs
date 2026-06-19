import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_DOMAIN = "https://infisical.phantasy.bot";

let cachedCfAccessToken = "";
let cachedCfAccessTokenAt = 0;

export function resolveInfisicalConfig(options = {}) {
  const infisicalJsonPath = resolve(process.cwd(), ".infisical.json");
  const infisicalJson = readFileSync(infisicalJsonPath, "utf8");
  const parsed = JSON.parse(infisicalJson);
  const domain = normalizeDomain(
    options.domain ??
      process.env.INFISICAL_API_URL ??
      process.env.INFISICAL_DOMAIN ??
      DEFAULT_DOMAIN,
  );
  return {
    domain,
    projectId: options.projectId ?? process.env.INFISICAL_PROJECT_ID ?? parsed.workspaceId,
    organizationId:
      options.organizationId ??
      process.env.INFISICAL_ORGANIZATION_ID ??
      parsed.organizationId ??
      "",
    secretType: options.secretType ?? process.env.INFISICAL_SECRET_TYPE ?? "shared",
  };
}

export function cfAccessHeaders() {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {};
  }
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

function cfAccessCookie(domain) {
  if (process.env.CF_ACCESS_COOKIE) {
    return process.env.CF_ACCESS_COOKIE;
  }

  const now = Date.now();
  if (cachedCfAccessToken && now - cachedCfAccessTokenAt < 5 * 60 * 1000) {
    return cachedCfAccessToken;
  }

  const result = spawnSync("cloudflared", ["access", "token", domain], { encoding: "utf8" });
  const token = result.stdout.trim();
  if (result.status === 0 && token.length > 0) {
    cachedCfAccessToken = token;
    cachedCfAccessTokenAt = now;
    return token;
  }

  return "";
}

export function infisicalRequestHeaders(domain, accessToken) {
  const headers = {
    ...cfAccessHeaders(),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const cookie = cfAccessCookie(domain);
  if (cookie) {
    headers.Cookie = `CF_Authorization=${cookie}`;
  }

  return headers;
}

function resolveCredentialsBlob(env = process.env) {
  const direct = env.INFISICAL_ACCESS_TOKEN?.trim();
  if (direct) {
    return direct;
  }

  const blob = env.INFISICAL_CREDENTIALS_BLOB?.trim();
  if (!blob) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    const token = parsed.JTWToken || parsed.JWTToken || parsed.accessToken || parsed.token;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  } catch {
    // Not a base64 credential export blob.
  }

  return undefined;
}

export async function getInfisicalAccessToken(domain) {
  const blobToken = resolveCredentialsBlob();
  if (blobToken) {
    const organizationId = resolveInfisicalConfig().organizationId;
    if (organizationId) {
      return selectOrganizationToken(domain, blobToken, organizationId);
    }
    return blobToken;
  }

  if (process.env.INFISICAL_ACCESS_TOKEN) {
    return process.env.INFISICAL_ACCESS_TOKEN;
  }
  if (process.env.INFISICAL_TOKEN) {
    return process.env.INFISICAL_TOKEN;
  }

  const email = process.env.INFISICAL_EMAIL;
  const password = process.env.INFISICAL_PASSWORD;
  if (email && password) {
    const response = await fetch(`${domain}/api/v3/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...infisicalRequestHeaders(domain),
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await parseJsonResponse(response, "Infisical email login");
    if (!data.accessToken) {
      throw new Error("Infisical email login response did not include an access token.");
    }
    return selectOrganizationToken(
      domain,
      data.accessToken,
      resolveInfisicalConfig().organizationId || undefined,
    );
  }

  const clientId =
    process.env.INFISICAL_MACHINE_CLIENT_ID ??
    process.env.INFISICAL_CLIENT_ID ??
    process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
  const clientSecret =
    process.env.INFISICAL_MACHINE_CLIENT_SECRET ??
    process.env.INFISICAL_CLIENT_SECRET ??
    process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const response = await fetch(`${domain}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...infisicalRequestHeaders(domain),
      },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const data = await parseJsonResponse(response, "Infisical machine auth");
    if (!data.accessToken) {
      throw new Error("Infisical machine auth response did not include an access token.");
    }
    return data.accessToken;
  }

  const cliDomain = domain.endsWith("/api") ? domain : `${domain}/api`;
  const result = spawnSync(
    "infisical",
    ["user", "get", "token", "--plain", "--silent", "--domain", cliDomain],
    { encoding: "utf8" },
  );
  const token = result.stdout.trim();
  if (result.status === 0 && token.length > 0) {
    const organizationId = resolveInfisicalConfig().organizationId;
    if (organizationId) {
      return selectOrganizationToken(domain, token, organizationId);
    }
    return token;
  }

  throw new Error(
    "Set INFISICAL_ACCESS_TOKEN, INFISICAL_EMAIL/PASSWORD, INFISICAL_MACHINE_CLIENT_ID/SECRET, or run `infisical login --domain https://infisical.phantasy.bot`.",
  );
}

export async function listInfisicalSecrets({ domain, projectId, envName, secretPath, secretType }) {
  const token = await getInfisicalAccessToken(domain);
  const url = new URL(`${domain}/api/v3/secrets/raw`);
  url.searchParams.set("workspaceId", projectId);
  url.searchParams.set("environment", envName);
  url.searchParams.set("secretPath", secretPath);
  url.searchParams.set("include_imports", "true");
  url.searchParams.set("type", secretType);

  const response = await fetch(url, {
    headers: infisicalRequestHeaders(domain, token),
  });
  if (response.status === 404) {
    return [];
  }
  const data = await parseJsonResponse(response, "Infisical list");
  return Array.isArray(data.secrets) ? data.secrets : [];
}

export async function deleteInfisicalSecret({
  domain,
  projectId,
  envName,
  secretPath,
  secretType,
  key,
}) {
  const token = await getInfisicalAccessToken(domain);
  const response = await fetch(`${domain}/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...infisicalRequestHeaders(domain, token),
    },
    body: JSON.stringify({
      workspaceId: projectId,
      environment: envName,
      secretPath,
      type: secretType,
    }),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `Infisical delete failed for ${key}: ${response.status} ${await response.text()}`,
    );
  }
  return true;
}

export async function upsertInfisicalSecret({
  domain,
  projectId,
  envName,
  secretPath,
  secretType,
  key,
  value,
  exists,
}) {
  const token = await getInfisicalAccessToken(domain);
  const method = exists ? "PATCH" : "POST";
  const response = await fetch(`${domain}/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...infisicalRequestHeaders(domain, token),
    },
    body: JSON.stringify({
      workspaceId: projectId,
      environment: envName,
      secretValue: value,
      secretPath,
      type: secretType,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Infisical ${exists ? "update" : "create"} failed for ${key}: ${response.status} ${await response.text()}`,
    );
  }
}

export function formatDotenv(secrets) {
  return secrets
    .slice()
    .sort((left, right) => left.secretKey.localeCompare(right.secretKey))
    .map((secret) => `${secret.secretKey}=${secret.secretValue ?? ""}`)
    .join("\n")
    .concat("\n");
}

function normalizeDomain(domain) {
  return domain.replace(/\/api\/?$/, "").replace(/\/+$/, "");
}

async function selectOrganizationToken(domain, accessToken, organizationIdOverride) {
  const organizationId =
    organizationIdOverride ??
    process.env.INFISICAL_ORGANIZATION_ID ??
    (await resolveDefaultOrganizationId(domain, accessToken));
  if (!organizationId) {
    return accessToken;
  }

  const response = await fetch(`${domain}/api/v3/auth/select-organization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...infisicalRequestHeaders(domain, accessToken),
    },
    body: JSON.stringify({ organizationId }),
  });
  const data = await parseJsonResponse(response, "Infisical organization selection");
  const token = data.token ?? data.accessToken;
  if (!token) {
    throw new Error("Infisical organization selection did not return an access token.");
  }
  return token;
}

async function resolveDefaultOrganizationId(domain, accessToken) {
  const response = await fetch(`${domain}/api/v1/organization`, {
    headers: infisicalRequestHeaders(domain, accessToken),
  });
  const data = await parseJsonResponse(response, "Infisical organization list");
  const organizations = Array.isArray(data.organizations) ? data.organizations : [];
  if (organizations.length === 0) {
    throw new Error("No Infisical organizations available for the authenticated user.");
  }

  const workspaceId = process.env.INFISICAL_PROJECT_ID ?? resolveInfisicalConfig().projectId;
  if (workspaceId) {
    for (const organization of organizations) {
      const orgToken = await selectOrganizationToken(domain, accessToken, organization.id);
      const workspacesResponse = await fetch(`${domain}/api/v1/workspace`, {
        headers: infisicalRequestHeaders(domain, orgToken),
      });
      const workspacesData = await parseJsonResponse(
        workspacesResponse,
        "Infisical workspace list",
      );
      const workspaces = Array.isArray(workspacesData.workspaces)
        ? workspacesData.workspaces
        : Array.isArray(workspacesData)
          ? workspacesData
          : [];
      if (workspaces.some((workspace) => workspace.id === workspaceId)) {
        return organization.id;
      }
    }
  }

  const preferredName = process.env.INFISICAL_ORGANIZATION_NAME?.trim().toLowerCase();
  if (preferredName) {
    const preferred = organizations.find(
      (organization) => organization.name?.trim().toLowerCase() === preferredName,
    );
    if (preferred?.id) {
      return preferred.id;
    }
  }

  return organizations[0].id;
}

async function parseJsonResponse(response, label) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned non-JSON response. Check Cloudflare Access credentials.`);
  }
}