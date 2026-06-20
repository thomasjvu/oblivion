#!/usr/bin/env node
/**
 * Configure Forgejo push mirror to GitHub and optional GitHub webhooks.
 *
 * Environment:
 *   FORGEJO_TOKEN
 *   FORGEJO_BASE_URL — default https://forgejo.phantasy.bot
 *   FORGEJO_REPO     — default oblivion/oblivion
 *   GITHUB_TOKEN
 *   GITHUB_REPO      — default thomasjvu/oblivion
 */

const forgejoBase = (process.env.FORGEJO_BASE_URL || 'https://forgejo.phantasy.bot').replace(
  /\/$/,
  '',
);
const forgejoRepo = process.env.FORGEJO_REPO || 'oblivion/oblivion';
const githubRepo = process.env.GITHUB_REPO || 'thomasjvu/oblivion';
const forgejoToken = process.env.FORGEJO_TOKEN?.trim();
const githubToken = process.env.GITHUB_TOKEN?.trim();

async function forgejoApi(path, init = {}) {
  const response = await fetch(`${forgejoBase}/api/v1${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `token ${forgejoToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Forgejo ${init.method || 'GET'} ${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function githubApi(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function ensureOrg(name) {
  try {
    const org = await forgejoApi(`/orgs/${encodeURIComponent(name)}`);
    return { org, created: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) {
      throw error;
    }
  }

  const created = await forgejoApi('/orgs', {
    method: 'POST',
    body: JSON.stringify({
      username: name,
      full_name: 'Oblivion',
      description: 'Oblivion privacy app — canonical Forgejo org',
      visibility: 'private',
    }),
  });
  return { org: created, created: true };
}

async function ensureRepo(owner, repo) {
  try {
    const existing = await forgejoApi(`/repos/${owner}/${repo}`);
    return { repo: existing, created: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('404')) {
      throw error;
    }
  }

  const created = await forgejoApi(`/orgs/${owner}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: repo,
      private: true,
      auto_init: false,
      default_branch: 'main',
    }),
  });
  return { repo: created, created: true };
}

async function ensurePushMirror() {
  const [owner, repo] = forgejoRepo.split('/');
  const mirrors = await forgejoApi(`/repos/${owner}/${repo}/push_mirrors`);
  const target = `https://github.com/${githubRepo}.git`;
  const existing = Array.isArray(mirrors)
    ? mirrors.find((entry) => entry.remote_address?.includes('github.com'))
    : null;
  if (existing) {
    return { mirror: 'exists', id: existing.id };
  }

  const remoteAddress = githubToken
    ? `https://x-access-token:${githubToken}@github.com/${githubRepo}.git`
    : target;

  const created = await forgejoApi(`/repos/${owner}/${repo}/push_mirrors`, {
    method: 'POST',
    body: JSON.stringify({
      remote_address: remoteAddress,
      sync_on_commit: true,
      interval: '10m',
    }),
  });
  return { mirror: 'created', id: created.id };
}

async function main() {
  if (!forgejoToken) {
    throw new Error('FORGEJO_TOKEN is required');
  }

  const [owner, repoName] = forgejoRepo.split('/');
  const results = {
    org: await ensureOrg(owner),
    repo: await ensureRepo(owner, repoName),
  };

  if (githubToken) {
    results.pushMirror = await ensurePushMirror();
  }

  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});