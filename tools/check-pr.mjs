#!/usr/bin/env node
// Pull request checks of the community registry (RFC-0015 "Pull request checks", 1-14).
//
// Three steps, so that untrusted archives are only opened without network:
//   scope   (git only)   which files the change touches and what kind of change it is;
//                        writes plan.json with the entry checks that need no I/O.
//   fetch   (network)    GitHub API lookups and downloads of every new version's assets
//                        into the work directory (sizes capped while streaming).
//   verify  (no network) hashes, record agreement, safe extraction, data only, package
//                        validation, licence, requirements, thumbnails; prints the table
//                        and fails when any check failed.
//   all                  the three in one process (local use).
//
// Change kinds (scope):
//   community  exactly one entries/community/<id>.json added or changed (any author).
//   official   only entries/official/*.json, opened by github-actions[bot] from a
//              sync-official/* branch (the sync job).
//   removal    entries/community/<id>.json deleted or reduced plus removed/<id>.json, by a
//              repository owner, member or collaborator (the report process).
//   reverify   status changes, unavailable removals and state/reverify.json, opened by
//              github-actions[bot] from a reverify/* branch (the re-verification job).
//   maintenance no entries/, removed/ or state/ file changes (tools, workflows, docs):
//              nothing to check here; the tool tests and code owner review cover it.
//
// Usage:
//   node tools/check-pr.mjs scope  --base REV [--head REV] --author LOGIN [--association A]
//                                  [--head-ref BRANCH] --work DIR
//   node tools/check-pr.mjs fetch  --work DIR
//   node tools/check-pr.mjs verify --work DIR [--expect-offline]
//   node tools/check-pr.mjs all    --base REV --author LOGIN --work DIR
// Environment: GITHUB_TOKEN (read-only, API only), HYPRUNE_GITHUB_API / GITHUB_API_URL,
// HYPRUNE_GITHUB_DOWNLOAD (tests), HYPRUNE_REGISTRY_SDK (built SDK, verify step),
// GITHUB_STEP_SUMMARY (a Markdown table is appended when set).
import { mkdirSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  parseArgs, defaultRoot, readJson, writeJson, git, gitShow, githubRepo, releaseUrlParts,
  tombstoneErrors, tombstoneHits, annotate, isMain, ID_RE,
} from './lib/common.mjs';
import { githubClient, download, canWrite, GitHubError } from './lib/github.mjs';
import { validateEntry, validateRecord, tagVersion, parseSemver, spdxValid, limits } from './lib/validate.mjs';
import { namingAdvice } from './lib/naming.mjs';

export const CHECKS = {
  1: 'Entry schema', 2: 'Id and ownership', 3: 'Tag and release', 4: 'Download and size', 5: 'Hashes',
  6: 'Record agreement', 7: 'Safe extraction', 8: 'Data only', 9: 'Package validation', 10: 'Declared licence',
  11: 'Requirements', 12: 'Thumbnails', 13: 'Removed', 14: 'Version history', 0: 'Change scope',
};
const BOT = 'github-actions[bot]';
const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const isPre = v => (parseSemver(v)?.prerelease.length ?? 0) > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = list => [...(list ?? [])].sort();

/** Collects check results. */
function results() {
  const list = [];
  const add = (check, ok, message, where = {}) => list.push({ check, name: CHECKS[check], ok, message, ...where });
  return { list, pass: (c, m, w) => add(c, true, m, w), fail: (c, m, w) => add(c, false, m, w) };
}

function parseEntryText(text) {
  try { return { entry: JSON.parse(text) }; } catch (e) { return { error: `not valid JSON: ${e.message}` }; }
}

function entriesAt(root, rev, tier) {
  const out = new Map();
  let names = [];
  try { names = git(root, ['ls-tree', '--name-only', `${rev}:entries/${tier}`], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(n => n.endsWith('.json')); } catch { /* no directory */ }
  for (const n of names) {
    const parsed = parseEntryText(gitShow(root, rev, `entries/${tier}/${n}`) ?? '');
    if (parsed.entry) out.set(n.slice(0, -5), parsed.entry);
  }
  return out;
}

function tombstonesAt(root, rev) {
  const map = new Map();
  let names = [];
  try { names = git(root, ['ls-tree', '--name-only', `${rev}:removed`], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(n => n.endsWith('.json')); } catch { /* none */ }
  for (const n of names) { try { map.set(n.slice(0, -5), JSON.parse(gitShow(root, rev, `removed/${n}`))); } catch { /* reported by scope */ } }
  return map;
}

// ---------------------------------------------------------------------------------------
// scope

/** Which kind of change this is; {mode, errors, files}. */
export function classify(files, { author, association, headRef = '' }) {
  const errors = [];
  const bot = author === BOT;
  const paths = files.map(f => f.path);
  const entryFile = /^entries\/(official|community)\/([^/]+)\.json$/;
  if (!files.length) return { mode: null, errors: ['the pull request changes no files'] };
  if (bot && headRef.startsWith('sync-official/')) {
    const bad = files.filter(f => !/^entries\/official\/[^/]+\.json$/.test(f.path) || f.status === 'D');
    if (bad.length) errors.push(`the official sync may only add or change entries/official/*.json (not ${bad.map(f => f.path).join(', ')})`);
    return { mode: 'official', errors };
  }
  if (bot && headRef.startsWith('reverify/')) {
    const ok = f => (entryFile.test(f.path) && (f.status === 'M' || (f.status === 'D' && f.path.startsWith('entries/community/'))))
      || (/^removed\/[^/]+\.json$/.test(f.path) && f.status !== 'D') || (f.path === 'state/reverify.json' && f.status !== 'D');
    const bad = files.filter(f => !ok(f));
    if (bad.length) errors.push(`the re-verification may only change entry status, remove unavailable community entries and update state/reverify.json (not ${bad.map(f => f.path).join(', ')})`);
    return { mode: 'reverify', errors };
  }
  if (!paths.some(p => /^(entries|removed|state)\//.test(p))) return { mode: 'maintenance', errors };
  const official = paths.filter(p => p.startsWith('entries/official/'));
  if (official.length) errors.push(`entries/official/ changes only through the official sync job (${official.join(', ')})`);
  const removed = files.filter(f => /^removed\/[^/]+\.json$/.test(f.path));
  if (removed.length) {
    const ids = new Set(files.map(f => (/^(?:entries\/community|removed)\/([^/]+)\.json$/.exec(f.path) ?? [])[1]));
    if (ids.has(undefined) || ids.size !== 1 || files.length > 2) errors.push('a removal changes exactly entries/community/<id>.json and removed/<id>.json of one id');
    if (!MAINTAINER_ASSOCIATIONS.includes(association)) errors.push(`only registry maintainers add tombstones (author association ${association ?? 'unknown'})`);
    return { mode: 'removal', errors };
  }
  if (files.length !== 1) errors.push(`a pull request adds or changes exactly one entries/community/<id>.json (this one changes ${files.length} files: ${paths.join(', ')})`);
  const f = files[0];
  if (files.length === 1 && !official.length) {
    if (!/^entries\/community\/[^/]+\.json$/.test(f.path)) errors.push(`${f.path}: only entries/community/<id>.json files can be listed by pull request`);
    else if (f.status === 'D') errors.push(`${f.path}: deleting an entry is a removal (add a tombstone in removed/, maintainers only)`);
  }
  return { mode: 'community', errors };
}

/** Offline entry checks of one changed entry: 1, 2 (ids), 13, 14. */
export function entryChecks(item, ctx, r) {
  const { entry, previous, tier } = item;
  const where = { item: item.file };
  // 1: schema and file name
  const problems = validateEntry(entry, { root: ctx.root });
  if (basename(item.file) !== `${entry?.id}.json`) problems.push(`file name must be ${entry?.id}.json`);
  if (problems.length) { r.fail(1, problems.join('; '), where); return false; }
  const regErrors = [];
  if (!githubRepo(entry.repo)) regErrors.push('repo must be the https://github.com/<owner>/<repo> URL of the package repository');
  for (const v of item.newVersions) {
    if (tier === 'community' && !v.record) regErrors.push(`${v.tag}: record is required in the community registry`);
    if (v.status && v.status !== 'available') regErrors.push(`${v.tag}: a new version can't be listed as ${v.status}`);
    const assets = [v.url, v.record?.url, ...(v.thumbnails ?? []).map(t => t.url)].filter(Boolean);
    const repo = githubRepo(entry.repo);
    for (const url of assets) {
      const p = releaseUrlParts(url);
      if (!p || !repo || p.owner.toLowerCase() !== repo.owner.toLowerCase() || p.repo.toLowerCase() !== repo.repo.toLowerCase() || p.tag !== v.tag)
        regErrors.push(`${v.tag}: ${url} is not a release asset of ${entry.repo} at tag ${v.tag}`);
    }
    const stem = `${entry.id}-${v.version}`;
    if (releaseUrlParts(v.url)?.asset !== `${stem}.tar.zst`) regErrors.push(`${v.tag}: the archive asset must be named ${stem}.tar.zst`);
    if (v.record && releaseUrlParts(v.record.url)?.asset !== `${stem}.release.json`) regErrors.push(`${v.tag}: the record asset must be named ${stem}.release.json`);
  }
  if (regErrors.length) r.fail(1, regErrors.join('; '), where); else r.pass(1, `valid 0.1 entry ${entry.id}`, where);
  // 2: ids (offline part)
  const idErrors = [];
  const repo = githubRepo(entry.repo);
  if (tier === 'community' && /^com\.hyprune\./.test(entry.id)) idErrors.push('com.hyprune.* ids are reserved for official entries');
  if (tier === 'official' && !/^com\.hyprune\./.test(entry.id)) idErrors.push('official entries use com.hyprune.* ids');
  const gh = /^io\.github\.([a-z0-9-]+)\./.exec(entry.id);
  if (gh && repo && gh[1] !== repo.owner.toLowerCase()) idErrors.push(`io.github.${gh[1]}.* ids belong to repositories of ${gh[1]}, not ${repo.owner}`);
  if (tier === 'community' && ctx.official.has(entry.id)) idErrors.push(`${entry.id} is an official entry`);
  if (previous && previous.repo !== entry.repo) idErrors.push(`${entry.id} is held by ${previous.repo}; an id can't change repository except through the report process`);
  if (previous && previous.type !== entry.type) idErrors.push(`type can't change (${previous.type} → ${entry.type})`);
  if (idErrors.length) r.fail(2, idErrors.join('; '), where); else r.pass(2, 'id is free and matches the repository', where);
  // 13: tombstones
  const hits = tombstoneHits(ctx.tombstones, { ...entry, versions: item.newVersions });
  if (hits.length) r.fail(13, hits.join('; '), where); else r.pass(13, 'no tombstone matches', where);
  // 14: version history
  const hist = [];
  for (const old of previous?.versions ?? []) {
    const now = entry.versions.find(v => v.tag === old.tag) ?? entry.versions.find(v => v.version === old.version);
    if (!now) { if (!item.allowRemoved?.(old)) hist.push(`version ${old.tag} disappeared without a removal`); continue; }
    for (const k of ['tag', 'url', 'sha256']) if (now[k] !== old[k]) hist.push(`${old.tag}: ${k} changed (${old[k]} → ${now[k]})`);
    const strip = v => { const { status, ...rest } = v; return rest; };
    if (!hist.length && !same(strip(now), strip(old))) hist.push(`${old.tag}: a listed version never changes (fields differ)`);
    if ((now.status ?? 'available') !== (old.status ?? 'available') && !item.allowStatus) hist.push(`${old.tag}: status is set by the re-verification, not by pull requests`);
  }
  if (hist.length) r.fail(14, hist.join('; '), where); else r.pass(14, previous ? `${previous.versions.length} listed version(s) unchanged` : 'new entry', where);
  if (!item.newVersions.length && item.mode === 'community') r.fail(14, 'the change adds no version', where);
  return true;
}

export function scope({ root, base, head = 'HEAD', author, association, headRef }) {
  const diff = git(root, ['diff', '--name-status', '--no-renames', `${base}...${head}`]).trim();
  const files = diff ? diff.split('\n').map(l => { const [status, path] = l.split('\t'); return { status: status[0], path }; }) : [];
  const { mode, errors } = classify(files, { author, association, headRef });
  const r = results();
  const plan = { mode, base, head: git(root, ['rev-parse', head]).trim(), author, association, headRef, items: [], results: r.list, warnings: [], hints: [] };
  if (errors.length) { for (const e of errors) r.fail(0, e); return plan; }
  r.pass(0, `${mode} change: ${files.map(f => `${f.status} ${f.path}`).join(', ')}`);
  const ctx = { root, official: entriesAt(root, base, 'official'), community: entriesAt(root, base, 'community'), tombstones: tombstonesAt(root, base) };
  const headTombstones = tombstonesAt(root, head);
  for (const f of files) {
    if (f.path === 'state/reverify.json') continue;
    if (f.path.startsWith('removed/')) {
      const name = basename(f.path, '.json');
      const t = headTombstones.get(name);
      const errs = t ? tombstoneErrors(name, t) : [`${f.path}: not valid JSON`];
      if (mode === 'reverify' && t?.reason !== 'unavailable') errs.push(`${f.path}: the re-verification only adds unavailable tombstones`);
      if (errs.length) r.fail(13, errs.join('; '), { item: f.path }); else r.pass(13, `tombstone ${t.reason} ${t.date}`, { item: f.path });
      continue;
    }
    const tier = f.path.split('/')[1];
    const id = basename(f.path, '.json');
    const previous = (tier === 'official' ? ctx.official : ctx.community).get(id) ?? null;
    if (f.status === 'D') {
      const t = headTombstones.get(id);
      if (!t || t.versions !== '*' || !previous?.versions.every(v => t.sha256.includes(v.sha256))) r.fail(13, `${f.path} is deleted without a tombstone for every version (removed/${id}.json with versions "*" and every hash)`, { item: f.path });
      else if (mode === 'reverify' && t.reason !== 'unavailable') r.fail(13, `${f.path}: the re-verification only removes unavailable entries`, { item: f.path });
      else r.pass(14, `entry removed (${t.reason})`, { item: f.path });
      continue;
    }
    const parsed = parseEntryText(gitShow(root, head, f.path) ?? '');
    if (parsed.error) { r.fail(1, `${f.path}: ${parsed.error}`, { item: f.path }); continue; }
    const entry = parsed.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.versions)) { r.fail(1, `${f.path}: not an entry object with versions`, { item: f.path }); continue; }
    const prevTags = new Set((previous?.versions ?? []).map(v => v.tag));
    const newVersions = mode === 'community' || mode === 'official' ? entry.versions.filter(v => !prevTags.has(v?.tag)) : [];
    const t = headTombstones.get(id);
    const item = {
      file: f.path, tier, id, entry, previous, newVersions, mode,
      allowStatus: mode === 'reverify',
      allowRemoved: mode === 'removal' ? old => !!t && (t.versions === '*' || t.versions.includes(old.version)) && t.sha256.includes(old.sha256) : undefined,
    };
    if (mode === 'reverify') {
      const strip = e => ({ ...e, versions: (e.versions ?? []).map(({ status, ...v }) => v) });
      if (!previous || !same(strip(entry), strip(previous))) r.fail(14, `${f.path}: the re-verification only changes versions[].status`, { item: f.path });
      else r.pass(14, 'status changes only', { item: f.path });
      continue;
    }
    if (mode === 'removal') {
      if (previous && entry.versions.length >= previous.versions.length) r.fail(14, `${f.path}: a removal only removes versions`, { item: f.path });
    }
    if (!entryChecks(item, ctx, r)) continue;
    plan.items.push({ file: f.path, tier, id, entry, previous, newTags: newVersions.map(v => v.tag) });
  }
  plan.indexes = { official: Object.fromEntries(ctx.official), community: Object.fromEntries(ctx.community) };
  return plan;
}

// ---------------------------------------------------------------------------------------
// fetch (network): API facts and downloads, nothing is interpreted here

async function safeDownload(url, path, maxBytes) {
  try { return await download(url, path, { maxBytes, timeoutMs: 60000 }); } catch (e) {
    return { error: e.message, status: e instanceof GitHubError ? e.status : undefined };
  }
}

export async function fetchFacts(plan, work, { gh = githubClient({ delayMs: 100 }) } = {}) {
  const facts = { items: {} };
  for (const item of plan.items) {
    const { entry } = item;
    const repo = githubRepo(entry.repo);
    const f = (facts.items[item.file] = { versions: {} });
    try {
      const info = await gh.repo(repo.owner, repo.repo);
      f.repo = info ? { owner: info.owner?.login, ownerType: info.owner?.type, name: info.name, fullName: info.full_name, topics: info.topics ?? [], private: !!info.private } : null;
    } catch (e) { f.repoError = e.message; }
    if (item.tier === 'community' && plan.mode === 'community') {
      try { f.permission = await gh.permission(repo.owner, repo.repo, plan.author); } catch (e) { f.permissionError = e instanceof GitHubError && e.status === 403 ? 'forbidden' : e.message; }
    }
    for (const tag of item.newTags) {
      const v = entry.versions.find(x => x.tag === tag);
      const dir = join(work, 'files', item.id, tag);
      mkdirSync(dir, { recursive: true });
      const vf = (f.versions[tag] = {});
      try { vf.tagCommit = await gh.tagCommit(repo.owner, repo.repo, tag); } catch (e) { vf.tagError = e.message; }
      try {
        const rel = await gh.releaseByTag(repo.owner, repo.repo, tag);
        vf.release = rel ? { draft: !!rel.draft, prerelease: !!rel.prerelease, author: rel.author?.login ?? null, assets: (rel.assets ?? []).map(a => ({ name: a.name, size: a.size })) } : null;
      } catch (e) { vf.releaseError = e.message; }
      const lim = limits[entry.type] ?? limits.world;
      vf.archive = await safeDownload(v.url, join(dir, 'archive.tar.zst'), Math.min(v.bytes, lim.bytes));
      vf.checksum = await safeDownload(`${v.url}.sha256`, join(dir, 'archive.sha256'), 4096);
      if (v.record) vf.record = await safeDownload(v.record.url, join(dir, 'record.json'), limits.record.bytes);
      vf.thumbnails = [];
      for (const [i, t] of (v.thumbnails ?? []).entries()) vf.thumbnails.push(await safeDownload(t.url, join(dir, `thumb-${i + 1}`), limits.thumbnail.bytes));
    }
  }
  writeJson(join(work, 'facts.json'), facts);
  return facts;
}

// ---------------------------------------------------------------------------------------
// verify (no network)

function worldCheckBinary() {
  const found = spawnSync('sh', ['-c', 'command -v hyprune-world-check'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

function requiredLibraries(manifest) {
  return sorted([...new Set((manifest?.objectAssets ?? []).map(a => a?.library).filter(l => typeof l === 'string'))]);
}

async function verifyVersion(item, v, vf, plan, sdk, r, warnings, stage) {
  const { entry } = item;
  const where = { item: item.file, tag: v.tag };
  const dir = join(stage.work, 'files', item.id, v.tag);
  const repo = githubRepo(entry.repo);
  // 3: tag and release
  const t3 = [];
  if (vf.tagError) t3.push(`tag lookup failed: ${vf.tagError}`);
  else if (!vf.tagCommit) t3.push(`tag ${v.tag} doesn't exist in ${repo.owner}/${repo.repo}`);
  if (tagVersion(v.tag)?.version !== v.version) t3.push(`tag ${v.tag} doesn't name version ${v.version}`);
  if (vf.releaseError) t3.push(`release lookup failed: ${vf.releaseError}`);
  else if (!vf.release) t3.push(`no published release for tag ${v.tag}`);
  else {
    if (vf.release.draft) t3.push('the release is a draft');
    if (isPre(v.version) && !vf.release.prerelease) t3.push(`${v.version} is a pre-release version but the release isn't marked as a pre-release`);
    if (!isPre(v.version) && vf.release.prerelease) warnings.push(`${item.id} ${v.tag}: the release is marked as a pre-release but ${v.version} isn't one`);
    const names = new Set(vf.release.assets.map(a => a.name));
    for (const url of [v.url, `${v.url}.sha256`, v.record?.url, ...(v.thumbnails ?? []).map(x => x.url)].filter(Boolean)) {
      const asset = releaseUrlParts(url)?.asset;
      if (!names.has(asset)) t3.push(`${asset} is not an asset of the release`);
    }
  }
  // 4: download and size
  const a = vf.archive;
  if (a.error) r.fail(4, `archive download failed: ${a.error}`, where);
  else if (a.contentLength !== null && a.contentLength !== v.bytes) r.fail(4, `Content-Length ${a.contentLength} differs from bytes ${v.bytes}`, where);
  else if (a.bytes !== v.bytes) r.fail(4, `downloaded ${a.bytes} bytes, entry says ${v.bytes}`, where);
  else r.pass(4, `${a.bytes} bytes`, where);
  // 5: hashes; read the record
  const h5 = [];
  let record = null;
  if (!a.error && a.sha256 !== v.sha256) h5.push(`archive sha256 ${a.sha256} differs from the entry ${v.sha256}`);
  if (vf.checksum.error) h5.push(`the .sha256 asset is missing (${vf.checksum.error})`);
  else {
    const line = readFileSync(join(dir, 'archive.sha256'), 'utf8');
    const want = `${v.sha256}  ${releaseUrlParts(v.url).asset}\n`;
    if (line !== want) h5.push(`the .sha256 asset must be exactly "${want.trim()}" and a newline`);
  }
  if (v.record) {
    if (vf.record.error) h5.push(`release record download failed: ${vf.record.error}`);
    else {
      const bytes = readFileSync(join(dir, 'record.json'));
      if (sha256(bytes) !== v.record.sha256) h5.push('release record sha256 differs from the entry');
      try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
      if (record?.archive?.sha256 !== v.sha256) h5.push('release record archive sha256 differs from the entry');
    }
  }
  if (h5.length) r.fail(5, h5.join('; '), where); else r.pass(5, `sha256 ${v.sha256.slice(0, 16)}… agrees${v.record ? ' with the record' : ''}`, where);
  // 3 (record): the tag points to the record's commit
  if (record && vf.tagCommit && record.source?.commit !== vf.tagCommit) t3.push(`tag ${v.tag} points to ${vf.tagCommit}, the record says ${record.source?.commit}`);
  if (t3.length) r.fail(3, t3.join('; '), where); else r.pass(3, `${v.tag} → ${vf.tagCommit?.slice(0, 12)}, release published`, where);

  // 7, 8: safe extraction and data only (the SDK's extractor)
  let extracted = null, manifest = null;
  const staging = join(stage.tmp, `${item.id}-${v.tag}`);
  if (!a.error && a.sha256 === v.sha256) {
    mkdirSync(staging, { recursive: true });
    try {
      extracted = await sdk.extractArchive(join(dir, 'archive.tar.zst'), staging, { limits: sdk.limitsFor(entry.type), expectRoot: entry.id });
      r.pass(7, `${extracted.files.length} files, ${extracted.expandedBytes} bytes expanded`, where);
      r.pass(8, 'data files only', where);
    } catch (e) {
      const rule = e.rule ?? 'archive.unsafe';
      if (rule === 'data.executable') { r.pass(7, 'archive structure is safe up to the data-only failure', where); r.fail(8, e.message, where); }
      else { r.fail(7, `${rule}: ${e.message}`, where); r.fail(8, 'not checked (extraction failed)', where); }
    }
  } else {
    r.fail(7, 'not checked (download or hash failed)', where);
    r.fail(8, 'not checked (download or hash failed)', where);
  }
  const pkg = extracted ? join(staging, extracted.root) : null;
  if (pkg) {
    const name = entry.type === 'world' ? 'world.json' : 'library.json';
    try { manifest = JSON.parse(readFileSync(join(pkg, name), 'utf8')); } catch { manifest = null; }
  }
  // 9 and 10: package validation (SDK world validate / library check, plus
  // hyprune-world-check when present) and the declared licence
  const l10 = [];
  if (!spdxValid(v.license)) l10.push('license is not a valid SPDX expression');
  if (pkg) {
    if (!manifest) r.fail(9, `${entry.type === 'world' ? 'world.json' : 'library.json'} missing or not JSON`, where);
    else {
      try {
        const out = entry.type === 'world' ? await sdk.validateWorld(pkg) : await sdk.validateLibrary(pkg);
        for (const w of out.warnings ?? []) warnings.push(`${item.id} ${v.tag}: ${w}`);
        let checker = '';
        if (entry.type === 'world') {
          const bin = stage.worldCheck;
          if (bin) {
            const res = spawnSync(bin, [pkg], { encoding: 'utf8', timeout: 300000 });
            if (res.status !== 0) throw new Error(`hyprune-world-check: ${(res.stderr || res.stdout || '').trim().split('\n').slice(-5).join(' ')}`);
            checker = ' and hyprune-world-check';
          } else warnings.push(`${item.id} ${v.tag}: hyprune-world-check is not on PATH; only the SDK's world validation ran`);
        }
        r.pass(9, `${entry.type === 'world' ? 'world validate' : 'library check'}${checker} passed`, where);
      } catch (e) {
        const msg = String(e.message ?? e);
        if (/attribution|Missing (LICENSE|ATTRIBUTION)/i.test(msg)) { l10.push(msg); r.pass(9, 'manifest validates up to attribution', where); }
        else r.fail(9, msg.split('\n').slice(0, 5).join('; '), where);
      }
      if (!spdxValid(manifest.license)) l10.push('manifest license is not a valid SPDX expression');
    }
  } else r.fail(9, 'not checked (extraction failed)', where);
  if (l10.length) r.fail(10, l10.join('; '), where); else r.pass(10, `${v.license} (${item.tier === 'official' ? 'official: reviewed in the building repository' : 'declared by the creator, not reviewed'})`, where);

  // 6: record ↔ entry ↔ manifest
  const d6 = [];
  const cmp = (what, x, y) => { if (!same(x, y)) d6.push(`${what}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`); };
  if (v.record) {
    if (!record) d6.push('release record is not JSON');
    else {
      const rec = validateRecord(record, { root: stage.root });
      if (rec.length) d6.push(`release record: ${rec.join('; ')}`);
      cmp('record type / entry type', record.type, entry.type);
      cmp('record id / entry id', record.id, entry.id);
      cmp('record version / entry version', record.version, v.version);
      cmp('record formatVersion / entry formatVersion', record.formatVersion, v.formatVersion);
      cmp('record license / entry license', record.license, v.license);
      cmp('record archive name / asset', record.archive?.name, releaseUrlParts(v.url)?.asset);
      for (const k of ['bytes', 'expandedBytes', 'files']) cmp(`record archive.${k} / entry ${k}`, record.archive?.[k], v[k]);
      cmp('record requires / entry requires', sorted(record.requires?.libraries), sorted(v.requires?.libraries));
      cmp('record thumbnails / entry thumbnails',
        (record.thumbnails ?? []).map(x => [x.name, x.sha256, x.width, x.height]),
        (v.thumbnails ?? []).map(x => [releaseUrlParts(x.url)?.asset, x.sha256, x.width, x.height]));
      cmp('record source.repo / entry repo', record.source?.repo?.replace(/\.git$/, ''), entry.repo);
      cmp('record source.tag / entry tag', record.source?.tag, v.tag);
    }
  }
  if (manifest) {
    cmp('manifest id / entry id', manifest.id, entry.id);
    cmp('manifest version / entry version', manifest.version, v.version);
    cmp('manifest formatVersion / entry formatVersion', manifest.formatVersion, v.formatVersion);
    cmp('manifest license / entry license', manifest.license, v.license);
    if (entry.type === 'world') cmp('manifest libraries / entry requires', requiredLibraries(manifest), sorted(v.requires?.libraries));
  }
  if (extracted) {
    cmp('archive files / entry files', extracted.files.length, v.files);
    cmp('archive expanded bytes / entry expandedBytes', extracted.expandedBytes, v.expandedBytes);
  }
  if (!pkg) d6.push('archive not checked');
  if (d6.length) r.fail(6, d6.join('; '), where); else r.pass(6, 'record, entry and manifest agree', where);

  // 11: requirements listed in the official or community index
  const missing = [];
  for (const ref of v.requires?.libraries ?? []) {
    const [id, version] = ref.split('@');
    const listed = [plan.indexes.official[id], plan.indexes.community[id]].some(e => e?.type === 'library' && e.versions.some(x => x.version === version && (x.status ?? 'available') === 'available'));
    if (!listed) missing.push(ref);
  }
  if (missing.length) r.fail(11, `not listed in the official or community index: ${missing.join(', ')}`, where);
  else r.pass(11, v.requires?.libraries?.length ? `${v.requires.libraries.length} required libraries listed` : 'no required libraries', where);

  // 12: thumbnails
  const t12 = [];
  (v.thumbnails ?? []).forEach((t, i) => {
    const got = vf.thumbnails[i];
    const asset = releaseUrlParts(t.url)?.asset ?? '';
    if (!new RegExp(`^${entry.id.replace(/\./g, '\\.')}-${v.version.replace(/\./g, '\\.')}\\.thumb-${i + 1}\\.(png|jpg)$`).test(asset)) t12.push(`thumbnail ${i + 1}: asset must be named ${entry.id}-${v.version}.thumb-${i + 1}.png or .jpg`);
    if (!got || got.error) { t12.push(`thumbnail ${i + 1}: download failed (${got?.error ?? 'missing'})`); return; }
    const bytes = readFileSync(join(dir, `thumb-${i + 1}`));
    if (sha256(bytes) !== t.sha256) t12.push(`thumbnail ${i + 1}: sha256 differs`);
    if (bytes.length > limits.thumbnail.bytes) t12.push(`thumbnail ${i + 1}: larger than 512 KiB`);
    const head = sdk.imageHeader(bytes);
    if (!head || !['png', 'jpeg'].includes(head.format)) t12.push(`thumbnail ${i + 1}: not PNG or JPEG`);
    else {
      if (head.format === 'png' && !asset.endsWith('.png')) t12.push(`thumbnail ${i + 1}: PNG data in a .jpg asset`);
      if (head.format === 'jpeg' && !asset.endsWith('.jpg')) t12.push(`thumbnail ${i + 1}: JPEG data in a .png asset`);
      if (head.width !== t.width || head.height !== t.height) t12.push(`thumbnail ${i + 1}: ${head.width}x${head.height}, entry says ${t.width}x${t.height}`);
      if (head.width > limits.thumbnail.width || head.height > limits.thumbnail.height) t12.push(`thumbnail ${i + 1}: larger than 1280 x 720`);
    }
  });
  if (t12.length) r.fail(12, t12.join('; '), where); else r.pass(12, `${(v.thumbnails ?? []).length} thumbnail(s)`, where);
  rmSync(staging, { recursive: true, force: true });
}

export async function verify(plan, work, { root = defaultRoot } = {}) {
  const r = results();
  r.list.push(...plan.results);
  const warnings = [...plan.warnings], hints = [...plan.hints];
  const facts = plan.items.length ? readJson(join(work, 'facts.json')) : { items: {} };
  const sdk = plan.items.some(i => i.newTags.length) ? await (await import('./lib/sdk.mjs')).loadSdk() : null;
  const tmp = mkdtempSync(join(work, 'staging-'));
  const stage = { work, tmp, root, worldCheck: worldCheckBinary() };
  try {
    for (const item of plan.items) {
      const f = facts.items[item.file] ?? { versions: {} };
      const where = { item: item.file };
      const { entry } = item;
      const repo = githubRepo(entry.repo);
      // 2 (API): repository, owner and the author's write access
      const o2 = [];
      if (f.repoError) o2.push(`repository lookup failed: ${f.repoError}`);
      else if (!f.repo) o2.push(`${entry.repo} doesn't exist or isn't public`);
      else {
        if (f.repo.private) o2.push(`${entry.repo} is private`);
        const owner = /^io\.github\.([a-z0-9-]+)\./.exec(entry.id)?.[1];
        if (owner && f.repo.owner?.toLowerCase() !== owner) o2.push(`io.github.${owner}.* needs a repository owned by ${owner} (owner is ${f.repo.owner})`);
        if (f.repo.owner?.toLowerCase() !== repo.owner.toLowerCase() || f.repo.name?.toLowerCase() !== repo.repo.toLowerCase())
          o2.push(`${entry.repo} moved to ${f.repo.fullName}; list the current URL`);
        if (item.tier === 'community' && plan.mode === 'community') {
          const author = plan.author?.toLowerCase();
          const releaseAuthors = item.newTags.map(t => f.versions[t]?.release?.author?.toLowerCase()).filter(Boolean);
          const ok = (f.permission && canWrite(f.permission))
            || (f.repo.ownerType === 'User' && f.repo.owner?.toLowerCase() === author)
            || (item.newTags.length && releaseAuthors.length === item.newTags.length && releaseAuthors.every(x => x === author));
          if (!ok) o2.push(`can't confirm that ${plan.author} has write access to ${repo.owner}/${repo.repo}: open the pull request from the repository owner's account or from the account that created the release${f.permission ? ` (permission: ${f.permission})` : ''}`);
        }
      }
      if (o2.length) r.fail(2, o2.join('; '), where); else r.pass(2, item.tier === 'community' ? `${plan.author} maintains ${repo.owner}/${repo.repo}` : `${repo.owner}/${repo.repo}`, where);
      // repository naming (warning only) and topics (hint)
      if (item.tier === 'community') {
        const advice = namingAdvice(entry, f.repo?.name ?? repo.repo, f.repo?.topics);
        warnings.push(...advice.warnings.map(w => `${item.id}: ${w}`));
        hints.push(...advice.hints.map(h => `${item.id}: ${h}`));
      }
      for (const tag of item.newTags) {
        const v = entry.versions.find(x => x.tag === tag);
        const vf = f.versions[tag] ?? { archive: { error: 'not downloaded' }, checksum: { error: 'not downloaded' }, thumbnails: [] };
        await verifyVersion(item, v, vf, plan, sdk, r, warnings, stage);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { results: r.list, warnings, hints, ok: r.list.every(x => x.ok) };
}

// ---------------------------------------------------------------------------------------
// reporting and CLI

export function report({ results: list, warnings, hints, ok }) {
  const lines = ['| # | Check | Result | Details |', '| --- | --- | --- | --- |'];
  for (const x of [...list].sort((a, b) => a.check - b.check)) {
    const what = [x.item, x.tag].filter(Boolean).join(' ');
    lines.push(`| ${x.check || '-'} | ${x.name} | ${x.ok ? 'pass' : '**fail**'} | ${what ? `${what}: ` : ''}${String(x.message).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  const md = [`### Registry checks: ${ok ? 'passed' : 'failed'}`, '', ...lines, ''];
  if (warnings.length) md.push('**Warnings** (never fail the check):', '', ...warnings.map(w => `- ${w}`), '');
  if (hints.length) md.push('**Hints:**', '', ...hints.map(h => `- ${h}`), '');
  return md.join('\n');
}

function print(outcome) {
  for (const x of [...outcome.results].sort((a, b) => a.check - b.check)) {
    const what = [x.item, x.tag].filter(Boolean).join(' ');
    console.log(`${x.ok ? 'pass' : 'FAIL'}  ${String(x.check || '-').padStart(2)} ${x.name.padEnd(18)} ${what ? `${what}: ` : ''}${x.message}`);
    if (!x.ok) annotate('error', `check ${x.check} (${x.name}): ${x.message}`, x.item);
  }
  for (const w of outcome.warnings) annotate('warning', w);
  for (const h of outcome.hints) annotate('notice', h);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report(outcome) + '\n');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, ['expect-offline']);
  const root = resolve(args.root ?? defaultRoot);
  const work = resolve(args.work ?? join(root, '.check'));
  mkdirSync(work, { recursive: true });
  const planPath = join(work, 'plan.json');
  const doScope = () => {
    if (!args.base) throw new Error('--base is required');
    const plan = scope({ root, base: args.base, head: args.head ?? 'HEAD', author: args.author, association: args.association, headRef: args['head-ref'] ?? '' });
    writeJson(planPath, plan);
    return plan;
  };
  if (cmd === 'scope') {
    const plan = doScope();
    const failed = plan.results.filter(x => !x.ok);
    for (const x of failed) annotate('error', `check ${x.check} (${x.name}): ${x.message}`, x.item);
    console.log(`${plan.mode ?? 'invalid'} change, ${plan.items.length} entr${plan.items.length === 1 ? 'y' : 'ies'} to check${failed.length ? `, ${failed.length} failed` : ''}`);
    if (plan.results.some(x => x.check === 0 && !x.ok)) { print({ results: plan.results, warnings: [], hints: [], ok: false }); process.exit(1); }
    return;
  }
  if (cmd === 'fetch') { await fetchFacts(readJson(planPath), work); console.log(`downloads in ${work}`); return; }
  if (cmd === 'verify' && args['expect-offline'] !== undefined) {
    // The CI runs verify in a network namespace without interfaces; refuse to run otherwise.
    const reachable = await fetch('https://api.github.com/', { signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
    if (reachable) { annotate('error', 'verify --expect-offline: the network is reachable'); process.exit(1); }
  }
  if (cmd === 'verify' || cmd === 'all') {
    const plan = cmd === 'all' ? doScope() : readJson(planPath);
    if (cmd === 'all' && plan.mode) await fetchFacts(plan, work);
    const outcome = await verify(plan, work, { root });
    print(outcome);
    if (!outcome.ok) process.exit(1);
    console.log('all checks passed');
    return;
  }
  console.error('usage: check-pr.mjs scope|fetch|verify|all [options] (see the header of this file)');
  process.exit(2);
}

if (isMain(import.meta.url)) await main();
