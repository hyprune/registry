// GitHub REST API and release download access for the registry tools.
//
// API base: HYPRUNE_GITHUB_API, else GITHUB_API_URL (set by GitHub Actions), else
// https://api.github.com. Release downloads: entry URLs are always
// https://github.com/<owner>/<repo>/releases/download/…; HYPRUNE_GITHUB_DOWNLOAD (tests)
// replaces the https://github.com prefix. GITHUB_TOKEN, when set, is sent to the API host
// only (read-only use). Plain http is refused except loopback with
// HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1 (tests).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';

const GITHUB = 'https://github.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function apiBase() {
  return (process.env.HYPRUNE_GITHUB_API || process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
}

export function downloadUrl(url) {
  const base = process.env.HYPRUNE_GITHUB_DOWNLOAD;
  if (base && url.startsWith(GITHUB + '/')) return base.replace(/\/$/, '') + url.slice(GITHUB.length);
  return url;
}

export function assertAllowedUrl(url) {
  const u = new URL(url);
  if (u.protocol === 'https:') return;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && loopback && process.env.HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP === '1') return;
  throw new Error(`refusing non-HTTPS URL ${url}`);
}

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * A small GitHub API client. `get(path)` returns the parsed JSON, or null on 404.
 * `delayMs` spaces requests (rate limiting for the scheduled jobs).
 */
export function githubClient({ token = process.env.GITHUB_TOKEN, base = apiBase(), delayMs = 0, timeoutMs = 30000 } = {}) {
  let last = 0;
  async function request(path) {
    const url = path.startsWith('http') ? path : base + path;
    assertAllowedUrl(url);
    if (delayMs) { const wait = last + delayMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hyprune-registry-tools' };
    if (token && new URL(url).origin === new URL(base).origin) headers.authorization = `Bearer ${token}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return { status: 404, json: null, headers: res.headers };
      if ((res.status === 403 || res.status === 429) && attempt < 2 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
        if (reset > 0 && reset < 120000) { await sleep(reset + 1000); continue; }
      }
      if (res.status >= 500 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new GitHubError(`GitHub API ${new URL(url).pathname}: HTTP ${res.status}`, res.status);
      return { status: res.status, json: await res.json(), headers: res.headers };
    }
  }
  return {
    base,
    async get(path) { return (await request(path)).json; },
    /** All pages of a list endpoint (per_page=100). */
    async list(path, max = 1000) {
      const out = [];
      for (let page = 1; out.length < max; page++) {
        const json = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!json?.length) break;
        out.push(...json);
        if (json.length < 100) break;
      }
      return out;
    },
    repo(owner, repo) { return this.get(`/repos/${owner}/${repo}`); },
    async releaseByTag(owner, repo, tag) {
      return this.get(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    },
    /** The commit a tag points to (annotated tags are peeled), or null when the tag doesn't exist. */
    async tagCommit(owner, repo, tag) {
      const ref = await this.get(`/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
      if (!ref || Array.isArray(ref)) return null;
      let obj = ref.object;
      for (let i = 0; obj?.type === 'tag' && i < 5; i++) obj = (await this.get(`/repos/${owner}/${repo}/git/tags/${obj.sha}`))?.object;
      return obj?.type === 'commit' ? obj.sha : null;
    },
    /** The user's permission on a repository: admin|maintain|write|triage|read|none. */
    async permission(owner, repo, user) {
      const json = await this.get(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(user)}/permission`);
      return json?.role_name ?? json?.permission ?? 'none';
    },
  };
}

/** Whether a permission grants write access. */
export const canWrite = p => ['admin', 'maintain', 'write'].includes(p);

/**
 * Download a URL into `path` (through `path.part`), hashing while streaming.
 * Stops with an error past `maxBytes`. Returns {bytes, sha256, contentLength}.
 * With `path` null the body is only hashed (re-verification).
 */
export async function download(url, path, { maxBytes = Infinity, timeoutMs = 30000 } = {}) {
  const real = downloadUrl(url);
  assertAllowedUrl(real);
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  let res;
  try { res = await fetch(real, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'hyprune-registry-tools' } }); } catch (e) { clearTimeout(timer); throw e; }
  // Redirect targets must stay HTTPS (or loopback in tests).
  try { assertAllowedUrl(res.url || real); } catch (e) { ctl.abort(); clearTimeout(timer); throw e; }
  if (!res.ok) { clearTimeout(timer); await res.body?.cancel().catch(() => {}); throw new GitHubError(`download ${url}: HTTP ${res.status}`, res.status); }
  const contentLength = res.headers.get('content-length') === null ? null : Number(res.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) { ctl.abort(); clearTimeout(timer); throw new Error(`download ${url}: Content-Length ${contentLength} exceeds ${maxBytes}`); }
  const hash = createHash('sha256');
  const part = path === null ? null : `${path}.part`;
  const out = part ? createWriteStream(part) : null;
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error('idle timeout')), timeoutMs);
      bytes += chunk.length;
      if (bytes > maxBytes) { ctl.abort(); throw new Error(`download ${url}: more than ${maxBytes} bytes`); }
      hash.update(chunk);
      if (out && !out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    if (out) await new Promise((res2, rej) => out.end(err => (err ? rej(err) : res2())));
    if (part) await rename(part, path);
  } catch (e) {
    if (out) { out.destroy(); await unlink(part).catch(() => {}); }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return { bytes, sha256: hash.digest('hex'), contentLength };
}
