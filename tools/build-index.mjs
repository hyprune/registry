#!/usr/bin/env node
// Build the two published indexes from the entry files:
//   public/v0.1/official.json   <- entries/official/*.json
//   public/v0.1/community.json  <- entries/community/*.json
// `$schema` is stripped, entries are sorted by id, `serial` is the number of commits on
// the built revision (`git rev-list --count HEAD`), `generated` is now (UTC). Both
// documents are validated against the pinned schema and the index limits before
// anything is written. Tombstoned ids, versions and hashes are left out (with a warning).
//
// Usage: node tools/build-index.mjs [--root DIR] [--out DIR] [--serial N] [--generated TIME]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, defaultRoot, loadEntries, loadTombstones, tombstoneErrors, tombstoneHits, git, annotate, isMain, TIERS } from './lib/common.mjs';
import { validateEntry, validateIndex } from './lib/validate.mjs';

const NAMES = { official: 'Hyprune official', community: 'Hyprune community registry' };
const HOMEPAGE = 'https://github.com/hyprune/registry';
const PAGES = 'https://hyprune.github.io/registry';

export function buildIndexes({ root = defaultRoot, serial, generated } = {}) {
  const errors = [], warnings = [];
  serial ??= Number(git(root, ['rev-list', '--count', 'HEAD']).trim());
  generated ??= new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!Number.isInteger(serial) || serial < 1) errors.push(`serial must be a positive integer (got ${serial})`);
  const tombstones = loadTombstones(root);
  for (const [name, t] of tombstones) errors.push(...tombstoneErrors(name, t));
  const seen = new Map();
  const docs = {};
  for (const tier of TIERS) {
    const entries = [];
    for (const { file, id, entry } of loadEntries(root, tier)) {
      const problems = validateEntry(entry, { root });
      if (entry.id !== id) problems.push(`file name must be ${entry.id}.json`);
      if (tier === 'community' && /^com\.hyprune\./.test(entry.id ?? '')) problems.push('com.hyprune.* ids are reserved for official entries');
      if (seen.has(entry.id)) problems.push(`id also listed in ${seen.get(entry.id)}`);
      seen.set(entry.id, file);
      if (problems.length) { errors.push(...problems.map(p => `${file}: ${p}`)); continue; }
      const { $schema, ...clean } = entry;
      const hits = tombstoneHits(tombstones, clean);
      if (hits.length) {
        warnings.push(...hits.map(h => `${file}: left out: ${h}`));
        const t = tombstones.get(clean.id);
        if (t?.versions === '*') continue;
        clean.versions = clean.versions.filter(v => !(t?.versions?.includes?.(v.version)) && ![...tombstones.values()].some(o => o.sha256.includes(v.sha256)));
        if (!clean.versions.length) continue;
      }
      entries.push(clean);
    }
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const doc = { indexVersion: '0.1', name: NAMES[tier], homepage: HOMEPAGE, serial, generated, entries };
    const text = JSON.stringify(doc, null, 1) + '\n';
    errors.push(...validateIndex(doc, { root, text }).map(e => `${tier}.json: ${e}`));
    docs[tier] = { doc, text };
  }
  return { docs, errors, warnings, serial, generated };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function indexHtml({ docs, serial, generated }) {
  const rows = TIERS.map(t => `<tr><td>${esc(NAMES[t])}</td><td><a href="v0.1/${t}.json">${PAGES}/v0.1/${t}.json</a></td><td>${docs[t].doc.entries.length}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hyprune registry</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}td,th{padding:.25rem .75rem;text-align:left}</style>
</head><body>
<h1>Hyprune registry</h1>
<p>Index documents (format 0.1) of Hyprune's built-in sources. They link to packages on their creators' GitHub Releases; nothing is hosted here. See <a href="${HOMEPAGE}">${HOMEPAGE}</a> and <a href="https://hyprune.com/rfcs/0015-registry/">RFC-0015</a>.</p>
<table><tr><th>Source</th><th>Index</th><th>Entries</th></tr>
${rows}
</table>
<p>Serial ${esc(serial)}, generated ${esc(generated)}.</p>
</body></html>
`;
}

export function writeIndexes(result, out) {
  mkdirSync(join(out, 'v0.1'), { recursive: true });
  for (const tier of TIERS) writeFileSync(join(out, 'v0.1', `${tier}.json`), result.docs[tier].text);
  writeFileSync(join(out, 'index.html'), indexHtml(result));
  writeFileSync(join(out, '.nojekyll'), '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? defaultRoot);
  const result = buildIndexes({ root, serial: args.serial === undefined ? undefined : Number(args.serial), generated: args.generated });
  for (const w of result.warnings) annotate('warning', w);
  if (result.errors.length) {
    for (const e of result.errors) annotate('error', e);
    process.exit(1);
  }
  const out = resolve(args.out ?? join(root, 'public'));
  writeIndexes(result, out);
  console.log(`serial ${result.serial}: official ${result.docs.official.doc.entries.length} entries, community ${result.docs.community.doc.entries.length} entries -> ${out}`);
}

if (isMain(import.meta.url)) await main();
