// Shared helpers of the registry tools: paths, JSON files, entries and tombstones.
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultRoot = resolve(toolsDir, '..');

export const ENTRY_SCHEMA = 'https://hyprune.com/schema/registry/v0.1/index.schema.json#/$defs/entry';
export const TIERS = ['official', 'community'];
export const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Write JSON with two-space indentation and a final newline, atomically. */
export function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Parse `--name value` and `--flag` arguments; positional arguments under `_`. */
export function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) out[k] = v;
    else if (flags.includes(k)) out[k] = true;
    else if (i + 1 < argv.length) out[k] = argv[++i];
    else throw new Error(`--${k} needs a value`);
  }
  return out;
}

/** Entry files of one tier as [{file, id, entry}] sorted by id. */
export function loadEntries(root, tier) {
  const dir = join(root, 'entries', tier);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const entry = readJson(join(dir, f));
    return { file: `entries/${tier}/${f}`, id: f.slice(0, -5), entry };
  });
}

/** Tombstones in removed/ keyed by id. */
export function loadTombstones(root) {
  const dir = join(root, 'removed');
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) map.set(f.slice(0, -5), readJson(join(dir, f)));
  return map;
}

export const REMOVAL_REASONS = ['rights', 'licence', 'safety', 'policy', 'broken', 'unavailable', 'creator-request'];

/** Errors of one tombstone file (empty when valid). */
export function tombstoneErrors(name, t) {
  const errors = [];
  const fail = m => errors.push(`removed/${name}.json: ${m}`);
  if (!t || typeof t !== 'object' || Array.isArray(t)) { fail('not an object'); return errors; }
  const allowed = new Set(['$schema', 'id', 'versions', 'sha256', 'reason', 'date', 'report', 'history']);
  for (const k of Object.keys(t)) if (!allowed.has(k)) fail(`unknown field ${k}`);
  if (t.id !== name) fail(`id must equal the file name (${name})`);
  if (!ID_RE.test(t.id ?? '')) fail('id is not a reverse-domain id');
  if (t.versions !== '*' && !(Array.isArray(t.versions) && t.versions.every(v => typeof v === 'string'))) fail('versions must be "*" or a list of versions');
  if (!Array.isArray(t.sha256) || !t.sha256.every(h => /^[0-9a-f]{64}$/.test(h))) fail('sha256 must be a list of lowercase sha256 hex digests');
  if (!REMOVAL_REASONS.includes(t.reason)) fail(`reason must be one of ${REMOVAL_REASONS.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '')) fail('date must be YYYY-MM-DD');
  if (!(t.report === null || (Number.isInteger(t.report) && t.report > 0))) fail('report must be an issue number or null');
  if (t.history !== undefined && !Array.isArray(t.history)) fail('history must be a list');
  return errors;
}

/** What a tombstone blocks for one entry: messages for the id, versions and hashes it names. */
export function tombstoneHits(tombstones, entry) {
  const hits = [];
  const t = tombstones.get(entry.id);
  if (t) {
    if (t.versions === '*') hits.push(`id ${entry.id} was removed (${t.reason}, ${t.date})`);
    else for (const v of entry.versions) if (t.versions.includes(v.version)) hits.push(`version ${v.version} was removed (${t.reason}, ${t.date})`);
  }
  for (const [id, other] of tombstones) for (const v of entry.versions)
    if (other.sha256.includes(v.sha256)) hits.push(`archive ${v.sha256} of ${v.tag} was removed with ${id} (${other.reason}, ${other.date})`);
  return hits;
}

export function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

/** File content at a git revision, or undefined when it doesn't exist there. */
export function gitShow(root, rev, path) {
  try { return git(root, ['show', `${rev}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; }
}

/** Today (UTC) as YYYY-MM-DD, overridable for tests with HYPRUNE_REGISTRY_TODAY. */
export function today() {
  return process.env.HYPRUNE_REGISTRY_TODAY || new Date().toISOString().slice(0, 10);
}

/** Owner and repository name of a GitHub repository URL, or undefined. */
export function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** The release tag of a GitHub release download URL `…/releases/download/<tag>/<asset>`. */
export function releaseUrlParts(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url ?? '');
  return m ? { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), asset: decodeURIComponent(m[4]) } : undefined;
}

/** Print a GitHub Actions annotation (plain text outside Actions). */
export function annotate(level, message, file) {
  const text = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}${file ? ` file=${file}` : ''}::${text}`);
  else console.log(`${level}: ${file ? `${file}: ` : ''}${message}`);
}

/** True when the module at `url` is the script node was started with. */
export function isMain(url) {
  return !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
}
