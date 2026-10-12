#!/usr/bin/env node
// Write entries/official/<id>.json from the meta repository's pins
// (worlds/releases.json and libraries/releases.json).
//
// For every published pin: the tag comes from the pinned URL
// (…/releases/download/<tag>/<asset>) and must name the pinned version; the pin's sha256
// and nixHash must agree; the archive is downloaded and hashed, its sizes and file count
// measured and its manifest read (name, description → summary, type, formatVersion,
// license, required libraries). The published date comes from the GitHub release. When
// the release carries an RFC-0015 release record (`<id>-<version>.release.json` with
// recordVersion 0.1) the version links it and takes its thumbnails; releases made before
// the record existed are imported without one. Creator `hyprune`, repo from the URL.
//
// Versions already in an entry are kept as they are (newest first); an existing version
// is never rewritten: a pin that changes the hash of a listed tag is an error.
//
// Usage: node tools/sync-official.mjs [--root DIR] [--worlds PATH|URL] [--libraries PATH|URL]
//          [--summary FILE]
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, defaultRoot, readJson, writeJson, releaseUrlParts, annotate, isMain, ENTRY_SCHEMA } from './lib/common.mjs';
import { githubClient, download, assertAllowedUrl } from './lib/github.mjs';
import { scanArchive } from './lib/tar.mjs';
import { validateEntry, validateRecord, compareSemver, tagVersion, limits } from './lib/validate.mjs';

const META_RAW = 'https://raw.githubusercontent.com/hyprune/hyprune/main';
export const DEFAULT_PINS = { world: `${META_RAW}/worlds/releases.json`, library: `${META_RAW}/libraries/releases.json` };

export const nixHashOf = hex => `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;

/** A one-line summary of at most 140 characters from a manifest description. */
export function summarize(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= 140) return s;
  const sentence = /^(.{1,140}?[.!?])(\s|$)/.exec(s)?.[1];
  if (sentence && sentence.length >= 40) return sentence;
  const cut = s.slice(0, 139);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 100)).replace(/[\s,;:.-]+$/, '') + '…';
}

async function readPins(where) {
  if (/^https?:\/\//.test(where)) {
    assertAllowedUrl(where);
    const res = await fetch(where, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`);
    return res.json();
  }
  return readJson(where);
}

const requiredLibraries = manifest => [...new Set((manifest.objectAssets || []).map(a => a?.library).filter(l => typeof l === 'string'))].sort();

/** Build one new version (and the manifest it came from) for a pin. */
async function versionFromPin(pin, type, { gh, work }) {
  const parts = releaseUrlParts(pin.url);
  if (!parts) throw new Error(`${pin.id}: url is not a GitHub release download URL`);
  const stem = `${pin.id}-${pin.version}`;
  if (parts.asset !== `${stem}.tar.zst`) throw new Error(`${pin.id}: asset ${parts.asset} must be ${stem}.tar.zst`);
  if (tagVersion(parts.tag)?.version !== pin.version) throw new Error(`${pin.id}: tag ${parts.tag} doesn't name version ${pin.version}`);
  if (!/^[0-9a-f]{64}$/.test(pin.sha256 ?? '')) throw new Error(`${pin.id}: sha256 is not lowercase hex`);
  if (pin.nixHash !== nixHashOf(pin.sha256)) throw new Error(`${pin.id}: nixHash ${pin.nixHash} doesn't match sha256 (${nixHashOf(pin.sha256)})`);

  const release = await gh.releaseByTag(parts.owner, parts.repo, parts.tag);
  if (!release) throw new Error(`${pin.id}: no GitHub release for tag ${parts.tag}`);
  if (release.draft) throw new Error(`${pin.id}: release ${parts.tag} is a draft`);
  const asset = name => (release.assets || []).find(a => a.name === name);
  if (!asset(parts.asset)) throw new Error(`${pin.id}: ${parts.asset} is not an asset of release ${parts.tag}`);

  const lim = limits[type];
  const file = join(work, parts.asset);
  const got = await download(pin.url, file, { maxBytes: lim.bytes, timeoutMs: 60000 });
  if (got.sha256 !== pin.sha256) throw new Error(`${pin.id}: downloaded archive sha256 ${got.sha256} differs from the pin ${pin.sha256}`);
  const scan = await scanArchive(file);
  await rm(file, { force: true });
  const m = scan.manifest;
  const want = type === 'world' ? 'world.json' : 'library.json';
  if (scan.roots.length !== 1 || scan.roots[0] !== pin.id) throw new Error(`${pin.id}: archive root must be exactly ${pin.id}/ (found ${scan.roots.join(', ')})`);
  if (!m || scan.manifestName !== want) throw new Error(`${pin.id}: archive has no ${pin.id}/${want}`);
  for (const k of ['id', 'version', 'formatVersion']) if (m[k] !== pin[k]) throw new Error(`${pin.id}: manifest ${k} ${m[k]} differs from the pin ${pin[k]}`);

  const version = {
    tag: parts.tag,
    version: pin.version,
    formatVersion: pin.formatVersion,
    published: String(release.published_at ?? release.created_at).slice(0, 10),
    license: m.license,
    url: pin.url,
    sha256: pin.sha256,
    bytes: got.bytes,
    expandedBytes: scan.expandedBytes,
    files: scan.files,
  };
  const notes = [];
  const recordAsset = asset(`${stem}.release.json`);
  if (recordAsset) {
    const url = `https://github.com/${parts.owner}/${parts.repo}/releases/download/${encodeURIComponent(parts.tag)}/${stem}.release.json`;
    const recordFile = join(work, `${stem}.release.json`);
    const r = await download(url, recordFile, { maxBytes: limits.record.bytes });
    let record;
    try { record = JSON.parse(readFileSync(recordFile, 'utf8')); } catch { record = null; }
    const problems = record?.recordVersion === '0.1' ? validateRecord(record) : ['not an RFC-0015 release record (no recordVersion 0.1)'];
    if (!problems.length) {
      if (record.archive.sha256 !== pin.sha256) throw new Error(`${pin.id}: release record archive sha256 differs from the pin`);
      version.record = { url, sha256: r.sha256 };
      const thumbs = (record.thumbnails || []).filter(t => asset(t.name));
      if (thumbs.length) version.thumbnails = thumbs.map(t => ({
        url: `https://github.com/${parts.owner}/${parts.repo}/releases/download/${encodeURIComponent(parts.tag)}/${t.name}`,
        sha256: t.sha256, width: t.width, height: t.height,
      }));
    } else notes.push(`${stem}.release.json ignored: ${problems[0]}`);
  } else notes.push('no release record asset: imported from the pin without a record');
  const libs = type === 'world' ? requiredLibraries(m) : [];
  if (libs.length) version.requires = { libraries: libs };
  return { version, manifest: m, repo: `https://github.com/${parts.owner}/${parts.repo}`, notes };
}

/**
 * Sync the official entries. Returns {changed: [file], errors: [msg], notes: [msg]}.
 */
export async function syncOfficial({ root = defaultRoot, pins = DEFAULT_PINS, gh = githubClient() } = {}) {
  const dir = join(root, 'entries', 'official');
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'hyprune-sync-'));
  const changed = [], errors = [], notes = [];
  try {
    for (const type of ['world', 'library']) {
      let doc;
      try { doc = await readPins(pins[type]); } catch (e) { errors.push(`${pins[type]}: ${e.message}`); continue; }
      for (const [key, pin] of Object.entries(doc)) {
        if (pin?.published === false) { notes.push(`${key}: not published, skipped`); continue; }
        const label = `${type} pin ${key}`;
        try {
          if (!pin?.id || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(pin.id)) throw new Error('missing or invalid id');
          const path = join(dir, `${pin.id}.json`);
          const existing = existsSync(path) ? readJson(path) : null;
          if (existing && existing.type !== type) throw new Error(`existing entry has type ${existing.type}`);
          const parts = releaseUrlParts(pin.url);
          const listed = existing?.versions.find(v => v.version === pin.version || (parts && v.tag === parts.tag));
          if (listed) {
            if (listed.sha256 !== pin.sha256 || listed.url !== pin.url || listed.tag !== parts?.tag)
              throw new Error(`version ${pin.version} is already listed with tag ${listed.tag}, ${listed.sha256}; a pin can't re-point a listed version`);
            continue;
          }
          const made = await versionFromPin(pin, type, { gh, work });
          notes.push(...made.notes.map(n => `${pin.id} ${made.version.tag}: ${n}`));
          const versions = [made.version, ...(existing?.versions ?? [])].sort((a, b) => compareSemver(b.version, a.version));
          const newest = versions[0] === made.version;
          const m = made.manifest;
          const entry = {
            $schema: ENTRY_SCHEMA,
            id: pin.id,
            type,
            name: newest ? String(m.name ?? pin.id).slice(0, 64) : existing.name,
            ...(newest ? (m.description ? { summary: summarize(m.description) } : {}) : (existing.summary !== undefined ? { summary: existing.summary } : {})),
            ...(newest ? (m.description && summarize(m.description) !== m.description.trim() ? { description: String(m.description).trim().slice(0, 2000) } : {})
              : (existing.description !== undefined ? { description: existing.description } : {})),
            creator: 'hyprune',
            repo: existing?.repo ?? made.repo,
            ...(existing?.tags ? { tags: existing.tags } : {}),
            versions,
          };
          const problems = validateEntry(entry, { root });
          if (problems.length) throw new Error(`generated entry is invalid: ${problems.join('; ')}`);
          writeJson(path, entry);
          changed.push(`entries/official/${pin.id}.json`);
          notes.push(`${pin.id}: added ${made.version.tag}`);
        } catch (e) {
          errors.push(`${label}: ${e.message}`);
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { changed, errors, notes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? defaultRoot);
  const pins = { world: args.worlds ?? DEFAULT_PINS.world, library: args.libraries ?? DEFAULT_PINS.library };
  const result = await syncOfficial({ root, pins });
  for (const n of result.notes) annotate('notice', n);
  for (const e of result.errors) annotate('error', e);
  if (args.summary) {
    const lines = ['Official entries synced from the meta repository pins (`worlds/releases.json`, `libraries/releases.json`).', ''];
    for (const n of result.notes) lines.push(`- ${n}`);
    for (const e of result.errors) lines.push(`- **error:** ${e}`);
    writeFileSync(args.summary, lines.join('\n') + '\n');
  }
  console.log(result.changed.length ? `changed: ${result.changed.join(', ')}` : 'official entries are up to date');
  if (result.errors.length) process.exit(1);
}

if (isMain(import.meta.url)) await main();
