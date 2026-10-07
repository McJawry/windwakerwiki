// github.js — talks to the GitHub REST API straight from the browser. No backend.
const API = 'https://api.github.com';

export const tokenStore = {
  get() { try { return localStorage.getItem('wiki:token') || ''; } catch { return ''; } },
  set(t) { try { localStorage.setItem('wiki:token', t); } catch {} },
  clear() { try { localStorage.removeItem('wiki:token'); } catch {} },
};

async function gh(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(j.message || r.statusText);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? null : r.json();
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const getUser = (token) => gh('/user', { token });
export const getRepo = (repo, token) => gh(`/repos/${repo}`, { token });

async function getSha(repo, path, ref, token) {
  try {
    const f = await gh(`/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, { token });
    return f.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function writeOps(repo, branch, ops, message, token) {
  let last = null;
  for (const op of ops) {
    const sha = await getSha(repo, op.path, branch, token);
    if (op.delete) {
      if (!sha) continue;
      last = await gh(`/repos/${repo}/contents/${encPath(op.path)}`, { method: 'DELETE', token, body: { message, sha, branch } });
    } else {
      last = await gh(`/repos/${repo}/contents/${encPath(op.path)}`, {
        method: 'PUT',
        token,
        body: { message, branch, content: op.b64 ?? utf8ToB64(op.content), ...(sha ? { sha } : {}) },
      });
    }
  }
  return last;
}

/**
 * Publish a set of file changes.
 *   ops:  [{path, content | b64 | delete:true}]
 *   mode: 'direct' commits to the base branch, 'pr' opens a pull request
 * Without push access the change goes through a fork automatically.
 */
export async function publish({ repo, baseBranch, token, user, canPush, mode, ops, message, prTitle, prBody }) {
  if (mode === 'direct') {
    if (!canPush) throw new Error('You do not have write access to this repository.');
    const res = await writeOps(repo, baseBranch, ops, message, token);
    return { kind: 'commit', url: res?.commit?.html_url || `https://github.com/${repo}` };
  }

  const base = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  const branch = `wiki-edit/${Date.now().toString(36)}`;
  let targetRepo = repo;
  let head = branch;

  if (!canPush) {
    const fork = await gh(`/repos/${repo}/forks`, { method: 'POST', token, body: {} });
    targetRepo = fork.full_name;
    head = `${fork.owner.login}:${branch}`;
    for (let i = 0; i < 20; i++) {
      try { await gh(`/repos/${targetRepo}`, { token }); break; } catch { await sleep(1500); }
    }
  }

  let created = false;
  for (let i = 0; i < 10 && !created; i++) {
    try {
      await gh(`/repos/${targetRepo}/git/refs`, { method: 'POST', token, body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
      created = true;
    } catch (e) {
      if (i === 9) throw e;
      await sleep(1500);
    }
  }

  await writeOps(targetRepo, branch, ops, message, token);
  const pr = await gh(`/repos/${repo}/pulls`, { method: 'POST', token, body: { title: prTitle || message, head, base: baseBranch, body: prBody || '' } });
  return { kind: 'pr', url: pr.html_url, number: pr.number };
}
