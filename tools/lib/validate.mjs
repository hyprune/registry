// Validation of entries, index documents and release records against the pinned
// registry 0.1 schemas in schema/v0.1/, plus the rules a schema can't express (the
// same rules as the schema repository's validateRegistry): versions unique and newest
// first by SemVer, the tag naming the version, SPDX expressions, per-type limits, ids
// unique in an index.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import parseSpdx from 'spdx-expression-parse';
import { defaultRoot } from './common.mjs';

const BASE = 'https://hyprune.com/schema/registry/v0.1/';

export const limits = Object.freeze({
  world: Object.freeze({ bytes: 512 * 1048576, expandedBytes: 1024 * 1048576, files: 10000, fileBytes: 128 * 1048576 }),
  library: Object.freeze({ bytes: 256 * 1048576, expandedBytes: 512 * 1048576, files: 4000, fileBytes: 32 * 1048576 }),
  index: Object.freeze({ bytes: 16 * 1048576, entries: 20000, versions: 64, thumbnails: 4 }),
  thumbnail: Object.freeze({ bytes: 512 * 1024, width: 1280, height: 720 }),
  record: Object.freeze({ bytes: 1048576 }),
});

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseSemver(text) {
  const m = typeof text === 'string' ? SEMVER.exec(text) : null;
  if (!m) return undefined;
  const pre = m[4] === undefined ? [] : m[4].split('.');
  if (pre.some(p => /^0\d+$/.test(p))) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: pre, build: m[5] ?? null };
}
export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`Invalid SemVer: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.prerelease.length || !y.prerelease.length) return Math.sign(y.prerelease.length - x.prerelease.length);
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i], q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { const d = BigInt(p) - BigInt(q); if (d) return d < 0n ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
/** {name|null, version} named by a tag (`v<version>` or `<name>-v<version>`), else undefined. */
export function tagVersion(tag) {
  if (typeof tag !== 'string') return undefined;
  const m = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)-)?v(\d[0-9A-Za-z.+-]*)$/.exec(tag);
  if (!m || !parseSemver(m[2])) return undefined;
  return { name: m[1] ?? null, version: m[2] };
}
export function spdxValid(text) {
  try { parseSpdx(text); return true; } catch { return false; }
}

let ajv;
function validator(ref, root) {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const name of ['index', 'release-record']) ajv.addSchema(JSON.parse(readFileSync(join(root, 'schema', 'v0.1', `${name}.schema.json`), 'utf8')));
  }
  return ajv.getSchema(BASE + ref);
}

function entryRules(entry, label, fail) {
  // extension is reserved in the schema (RFC-0007 process extensions): no client installs
  // one yet, so the registry lists none until an extension host exists.
  if (!limits[entry.type]) return fail(`${label}type ${entry.type} is reserved: the registry lists worlds and libraries until an extension host exists`);
  const lim = limits[entry.type];
  const tags = new Set(), versions = new Set();
  entry.versions.forEach((v, i) => {
    const at = `${label}versions/${i} (${v.tag})`;
    if (tags.has(v.tag)) fail(`${at}: duplicate tag`); tags.add(v.tag);
    if (versions.has(v.version)) fail(`${at}: duplicate version ${v.version}`); versions.add(v.version);
    if (!parseSemver(v.version)) fail(`${at}: version ${v.version} is not SemVer`);
    const named = tagVersion(v.tag);
    if (!named || named.version !== v.version) fail(`${at}: tag must name version ${v.version} (v${v.version} or <name>-v${v.version})`);
    if (i > 0 && parseSemver(v.version) && parseSemver(entry.versions[i - 1].version) && compareSemver(entry.versions[i - 1].version, v.version) <= 0)
      fail(`${at}: versions must be newest first (${entry.versions[i - 1].version} before ${v.version})`);
    if (!spdxValid(v.license)) fail(`${at}: license: invalid SPDX expression`);
    if (v.bytes > lim.bytes) fail(`${at}: bytes ${v.bytes} exceed the ${entry.type} archive limit ${lim.bytes}`);
    if (v.expandedBytes > lim.expandedBytes) fail(`${at}: expandedBytes ${v.expandedBytes} exceed the ${entry.type} limit ${lim.expandedBytes}`);
    if (v.files > lim.files) fail(`${at}: files ${v.files} exceed the ${entry.type} limit ${lim.files}`);
    if (entry.type === 'library' && v.requires?.libraries?.length) fail(`${at}: a library requires no libraries`);
    if ((v.requires?.libraries || []).some(r => r.startsWith(entry.id + '@'))) fail(`${at}: requires itself`);
  });
}

const fmt = errors => errors.map(e => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);

/** Validate one entry (an entry file's content when `file` is true: `$schema` allowed). */
export function validateEntry(entry, { file = true, root = defaultRoot } = {}) {
  const check = validator('index.schema.json#/$defs/entry', root);
  if (!check(entry)) return fmt(check.errors);
  const errors = [];
  if (!file && entry.$schema !== undefined) errors.push('$schema belongs to entry files, not index entries');
  entryRules(entry, '', m => errors.push(m));
  return errors;
}

/** Validate a whole index document, including its serialized size. */
export function validateIndex(doc, { root = defaultRoot, text } = {}) {
  const errors = [];
  const size = Buffer.byteLength(text ?? JSON.stringify(doc));
  if (size > limits.index.bytes) errors.push(`index is ${size} bytes, over the ${limits.index.bytes} byte limit`);
  const check = validator('index.schema.json', root);
  if (!check(doc)) return [...errors, ...fmt(check.errors)];
  const ids = new Set();
  doc.entries.forEach((entry, i) => {
    if (ids.has(entry.id)) errors.push(`entries/${i}: duplicate id ${entry.id}`); ids.add(entry.id);
    if (entry.$schema !== undefined) errors.push(`entries/${i}: $schema belongs to entry files, not index entries`);
    entryRules(entry, `entries/${i} ${entry.id}: `, m => errors.push(m));
  });
  return errors;
}

/** Validate a release record. */
export function validateRecord(record, { root = defaultRoot } = {}) {
  const check = validator('release-record.schema.json', root);
  if (!check(record)) return fmt(check.errors);
  const errors = [], fail = m => errors.push(m);
  const lim = limits[record.type], stem = `${record.id}-${record.version}`;
  if (!spdxValid(record.license)) fail('license: invalid SPDX expression');
  const named = tagVersion(record.source.tag);
  if (!named || named.version !== record.version) fail(`source.tag: ${record.source.tag} must name version ${record.version}`);
  if (record.archive.name !== `${stem}.tar.zst`) fail(`archive.name: must be ${stem}.tar.zst`);
  if (record.archive.bytes > lim.bytes) fail(`archive.bytes exceed the ${record.type} limit`);
  if (record.archive.expandedBytes > lim.expandedBytes) fail(`archive.expandedBytes exceed the ${record.type} limit`);
  if (record.archive.files > lim.files) fail(`archive.files exceed the ${record.type} limit`);
  return errors;
}
