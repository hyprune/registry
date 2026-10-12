#!/usr/bin/env node
// Write (or print) the community entry for a published release, from its release record
// and archive: `<id>-<version>.release.json` gives id, version, format, licence, sizes,
// requirements and thumbnails; the archive (downloaded and hashed) gives the manifest's
// name and description; the GitHub release gives the published date. A version is
// added at the top of an existing entry file; a listed tag is never rewritten.
//
// Usage: node tools/make-entry.mjs github:<owner>/<repo>@<tag> [--root DIR] [--write] [--tags a,b]
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, defaultRoot, readJson, writeJson, annotate, isMain, ENTRY_SCHEMA } from './lib/common.mjs';
import { githubClient, download } from './lib/github.mjs';
import { scanArchive } from './lib/tar.mjs';
import { validateEntry, validateRecord, compareSemver, limits } from './lib/validate.mjs';
import { summarize } from './sync-official.mjs';

export async function makeEntry(spec, { root = defaultRoot, gh = githubClient(), tags } = {}) {
  const m = /^github:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@(.+)$/.exec(spec);
  if (!m) throw new Error('expected github:<owner>/<repo>@<tag>');
  const [, owner, repo, tag] = m;
  const info = await gh.repo(owner, repo);
  if (!info) throw new Error(`${owner}/${repo} doesn't exist or isn't public`);
  const release = await gh.releaseByTag(owner, repo, tag);
  if (!release) throw new Error(`no published release for tag ${tag}`);
  const records = (release.assets ?? []).filter(a => a.name.endsWith('.release.json'));
  if (records.length !== 1) throw new Error(`the release needs exactly one <id>-<version>.release.json asset (found ${records.length})`);
  const base = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}`;
  const work = mkdtempSync(join(tmpdir(), 'hyprune-entry-'));
  try {
    const recordUrl = `${base}/${records[0].name}`;
    const r = await download(recordUrl, join(work, 'record.json'), { maxBytes: limits.record.bytes });
    const record = JSON.parse(readFileSync(join(work, 'record.json'), 'utf8'));
    const problems = validateRecord(record, { root });
    if (problems.length) throw new Error(`release record: ${problems.join('; ')}`);
    if (record.source.tag !== tag) throw new Error(`release record names tag ${record.source.tag}, not ${tag}`);
    const url = `${base}/${record.archive.name}`;
    const a = await download(url, join(work, 'archive.tar.zst'), { maxBytes: record.archive.bytes, timeoutMs: 60000 });
    if (a.sha256 !== record.archive.sha256) throw new Error(`archive sha256 ${a.sha256} differs from the record`);
    const scan = await scanArchive(join(work, 'archive.tar.zst'));
    const manifest = scan.manifest ?? {};
    const version = {
      tag, version: record.version, formatVersion: record.formatVersion,
      published: String(release.published_at ?? release.created_at).slice(0, 10),
      license: record.license, url, sha256: a.sha256, bytes: a.bytes,
      expandedBytes: record.archive.expandedBytes, files: record.archive.files,
      record: { url: recordUrl, sha256: r.sha256 },
      ...(record.requires?.libraries?.length ? { requires: { libraries: record.requires.libraries } } : {}),
      ...(record.thumbnails?.length ? { thumbnails: record.thumbnails.map(t => ({ url: `${base}/${t.name}`, sha256: t.sha256, width: t.width, height: t.height })) } : {}),
    };
    const path = join(root, 'entries', 'community', `${record.id}.json`);
    const existing = existsSync(path) ? readJson(path) : null;
    if (existing?.versions.some(v => v.tag === tag || v.version === record.version)) throw new Error(`${record.id} already lists ${tag}`);
    const versions = [version, ...(existing?.versions ?? [])].sort((x, y) => compareSemver(y.version, x.version));
    const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
    const entry = existing
      ? { ...existing, versions }
      : {
        $schema: ENTRY_SCHEMA, id: record.id, type: record.type, name: record.name,
        ...(description ? { summary: summarize(description) } : {}),
        ...(description && summarize(description) !== description ? { description: description.slice(0, 2000) } : {}),
        creator: owner, repo: `https://github.com/${owner}/${repo}`,
        ...(tags?.length ? { tags } : {}),
        versions,
      };
    const errors = validateEntry(entry, { root });
    if (errors.length) throw new Error(`entry is invalid: ${errors.join('; ')}`);
    return { entry, path, file: `entries/community/${record.id}.json` };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['write']);
  const root = resolve(args.root ?? defaultRoot);
  try {
    const { entry, path, file } = await makeEntry(args._[0] ?? '', { root, tags: args.tags?.split(',').filter(Boolean) });
    if (args.write) { writeJson(path, entry); console.log(`wrote ${file}`); } else console.log(JSON.stringify(entry, null, 2));
  } catch (e) {
    annotate('error', e.message);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) await main();
