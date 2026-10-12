#!/usr/bin/env node
// Re-verify every listed version (RFC-0015 "reverify.yml"): download the archive again
// (hash only, nothing is extracted), check its sha256 and size, re-read the release
// record when the version links one, and resolve the tag to its commit.
//
// A version becomes `status: "unavailable"` when its asset is gone (HTTP 404/410), its
// bytes or hash changed, its record changed, or its tag was deleted or moved. Network
// errors and server errors mark nothing (the next run retries). A version that verifies
// again with the same bytes and the same commit becomes available again.
//
// State: state/reverify.json keeps, per id and tag, the commit the tag pointed to when it
// was first verified (the record's source.commit when there is one) and, for unavailable
// versions, the date and reason. Entry files carry only `status`, as the schema allows.
//
// A community entry whose every version has been unavailable for 30 days is removed:
// its file is deleted and removed/<id>.json gets a tombstone with reason `unavailable`
// (report null). Official entries are only marked; their pins are fixed in the meta
// repository.
//
// Usage: node tools/reverify.mjs [--root DIR] [--delay-ms N] [--summary FILE] [--only ID]
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs, defaultRoot, loadEntries, loadTombstones, readJson, writeJson, githubRepo, releaseUrlParts, today, annotate, isMain, TIERS } from './lib/common.mjs';
import { githubClient, download, GitHubError } from './lib/github.mjs';
import { limits } from './lib/validate.mjs';

export const REMOVE_AFTER_DAYS = 30;
const GONE = new Set([404, 410]);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

class Unavailable extends Error {}
class Transient extends Error {}

async function verifyVersion(entry, v, known, { gh, work }) {
  const parts = releaseUrlParts(v.url);
  const repo = parts ?? githubRepo(entry.repo);
  if (!repo) throw new Transient('not a GitHub repository URL: skipped');
  const lim = limits[entry.type];
  // Archive: same bytes, same hash.
  let got;
  try {
    got = await download(v.url, null, { maxBytes: Math.min(v.bytes, lim.bytes), timeoutMs: 60000 });
  } catch (e) {
    if (e instanceof GitHubError && GONE.has(e.status)) throw new Unavailable('archive asset is gone');
    if (/more than|exceeds/.test(e.message)) throw new Unavailable('archive is larger than listed (asset changed)');
    throw new Transient(`archive download failed: ${e.message}`);
  }
  if (got.bytes !== v.bytes) throw new Unavailable(`archive size changed (${got.bytes}, listed ${v.bytes})`);
  if (got.sha256 !== v.sha256) throw new Unavailable('archive hash changed');
  // Record: same hash; its commit is the tag's commit.
  let recordCommit;
  if (v.record) {
    const file = join(work, 'record.json');
    let r;
    try { r = await download(v.record.url, file, { maxBytes: limits.record.bytes }); } catch (e) {
      if (e instanceof GitHubError && GONE.has(e.status)) throw new Unavailable('release record asset is gone');
      throw new Transient(`record download failed: ${e.message}`);
    }
    if (r.sha256 !== v.record.sha256) throw new Unavailable('release record hash changed');
    try { recordCommit = JSON.parse(readFileSync(file, 'utf8')).source?.commit; } catch { throw new Unavailable('release record is not JSON'); }
  }
  // Tag: still there, still on the same commit.
  let commit;
  try { commit = await gh.tagCommit(repo.owner, repo.repo, v.tag); } catch (e) { throw new Transient(`tag lookup failed: ${e.message}`); }
  if (!commit) throw new Unavailable(`tag ${v.tag} was deleted`);
  const expected = recordCommit ?? known?.commit;
  if (expected && commit !== expected) throw new Unavailable(`tag ${v.tag} moved (${expected.slice(0, 12)} → ${commit.slice(0, 12)})`);
  return commit;
}

/**
 * Re-verify all entries. Returns {changed: [file], marked, restored, removed, skipped, report: [line]}.
 */
export async function reverify({ root = defaultRoot, gh = githubClient({ delayMs: 250 }), only, date = today() } = {}) {
  const statePath = join(root, 'state', 'reverify.json');
  const state = existsSync(statePath) ? readJson(statePath) : { version: 1, entries: {} };
  const tombstones = loadTombstones(root);
  const out = { changed: new Set(), marked: [], restored: [], removed: [], skipped: [], report: [] };
  const work = mkdtempSync(join(tmpdir(), 'hyprune-reverify-'));
  try {
    for (const tier of TIERS) for (const { file, entry } of loadEntries(root, tier)) {
      if (only && entry.id !== only) continue;
      const known = (state.entries[entry.id] ??= {});
      let dirty = false;
      for (const v of entry.versions) {
        const k = (known[v.tag] ??= {});
        try {
          const commit = await verifyVersion(entry, v, k, { gh, work });
          k.commit ??= commit;
          if (v.status === 'unavailable') {
            delete v.status; delete k.unavailableSince; delete k.reason; dirty = true;
            out.restored.push(`${entry.id} ${v.tag}`);
          }
        } catch (e) {
          if (e instanceof Unavailable) {
            if (v.status !== 'unavailable') {
              v.status = 'unavailable'; k.unavailableSince = date; dirty = true;
              out.marked.push(`${entry.id} ${v.tag}: ${e.message}`);
              if (tier === 'official') annotate('error', `official ${entry.id} ${v.tag}: ${e.message}`);
            }
            k.reason = e.message;
            k.unavailableSince ??= date;
          } else {
            out.skipped.push(`${entry.id} ${v.tag}: ${e.message}`);
          }
        }
      }
      for (const tag of Object.keys(known)) if (!entry.versions.some(v => v.tag === tag)) delete known[tag];
      const allGone = entry.versions.every(v => v.status === 'unavailable');
      const since = allGone ? entry.versions.map(v => known[v.tag].unavailableSince).sort().at(-1) : null;
      if (tier === 'community' && allGone && since && daysBetween(since, date) >= REMOVE_AFTER_DAYS) {
        const old = tombstones.get(entry.id);
        const tomb = {
          id: entry.id,
          versions: '*',
          sha256: [...new Set([...(old?.sha256 ?? []), ...entry.versions.map(v => v.sha256)])],
          reason: 'unavailable',
          date,
          report: null,
          ...(old ? { history: [...(old.history ?? []), { versions: old.versions, reason: old.reason, date: old.date, report: old.report }] } : {}),
        };
        mkdirSync(join(root, 'removed'), { recursive: true });
        writeJson(join(root, 'removed', `${entry.id}.json`), tomb);
        unlinkSync(join(root, file));
        delete state.entries[entry.id];
        out.changed.add(file); out.changed.add(`removed/${entry.id}.json`);
        out.removed.push(`${entry.id}: every version unavailable since ${since}`);
        continue;
      }
      if (dirty) { writeJson(join(root, file), entry); out.changed.add(file); }
    }
    for (const id of Object.keys(state.entries)) if (!TIERS.some(t => existsSync(join(root, 'entries', t, `${id}.json`)))) delete state.entries[id];
    const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
    const text = JSON.stringify(state, null, 2) + '\n';
    if (text !== before) { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(statePath, text); out.changed.add('state/reverify.json'); }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const section = (title, list) => (list.length ? [`### ${title}`, '', ...list.map(l => `- ${l}`), ''] : []);
  out.report = [
    ...section('Marked unavailable', out.marked),
    ...section('Available again', out.restored),
    ...section(`Removed (every version unavailable for ${REMOVE_AFTER_DAYS} days)`, out.removed),
    ...section('Not checked this time (transient errors)', out.skipped),
  ];
  out.changed = [...out.changed];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? defaultRoot);
  const gh = githubClient({ delayMs: Number(args['delay-ms'] ?? 250) });
  const result = await reverify({ root, gh, only: args.only });
  for (const s of result.skipped) annotate('warning', s);
  const body = ['Weekly re-verification of every listed version (`tools/reverify.mjs`).', '', ...(result.report.length ? result.report : ['Every version verified.'])].join('\n') + '\n';
  if (args.summary) writeFileSync(args.summary, body);
  console.log(body);
  console.log(result.changed.length ? `changed: ${result.changed.join(', ')}` : 'no changes');
}

if (isMain(import.meta.url)) await main();
