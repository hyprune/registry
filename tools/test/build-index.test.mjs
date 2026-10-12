import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRelease, makeRegistry, entryFor, tmp } from '../test-support/fixtures.mjs';
import { buildIndexes, writeIndexes } from '../build-index.mjs';
import { validateIndex, limits } from '../lib/validate.mjs';

const official = (id, rel) => ({ ...entryFor({ id, owner: 'hyprune', repo: 'worlds', versions: [rel.versionEntry] }), creator: 'hyprune' });

test('builds both indexes: serial from the commit count, $schema stripped, sorted by id', () => {
  const a = makeRelease({ owner: 'ada', repo: 'r1', id: 'io.github.ada.zeta', version: '1.0.0' });
  const b = makeRelease({ owner: 'bea', repo: 'r2', id: 'io.github.bea.alpha', version: '0.1.0', thumbnails: 0 });
  const o = makeRelease({ owner: 'hyprune', repo: 'worlds', id: 'com.hyprune.starter', version: '0.1.0', tag: 'hyprune-starter-v0.1.0', thumbnails: 0 });
  const reg = makeRegistry({
    'entries/community/io.github.ada.zeta.json': entryFor({ id: 'io.github.ada.zeta', owner: 'ada', repo: 'r1', versions: [a.versionEntry] }),
    'entries/community/io.github.bea.alpha.json': entryFor({ id: 'io.github.bea.alpha', owner: 'bea', repo: 'r2', versions: [b.versionEntry] }),
    'entries/official/com.hyprune.starter.json': official('com.hyprune.starter', o),
  });
  reg.commit('second'); reg.commit('third');
  const result = buildIndexes({ root: reg.root });
  assert.deepEqual(result.errors, []);
  assert.equal(result.serial, 3);
  assert.match(result.generated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const community = result.docs.community.doc;
  assert.equal(community.indexVersion, '0.1');
  assert.equal(community.name, 'Hyprune community registry');
  assert.deepEqual(community.entries.map(e => e.id), ['io.github.bea.alpha', 'io.github.ada.zeta'].sort());
  assert.ok(community.entries.every(e => e.$schema === undefined));
  assert.deepEqual(result.docs.official.doc.entries.map(e => e.id), ['com.hyprune.starter']);
  const out = tmp('out');
  writeIndexes(result, out);
  const served = JSON.parse(readFileSync(join(out, 'v0.1', 'community.json'), 'utf8'));
  assert.deepEqual(validateIndex(served), []);
  assert.equal(served.serial, 3);
  assert.ok(existsSync(join(out, 'index.html')));
  assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /Serial 3/);
});

test('invalid entries, wrong file names and reserved ids fail the build', () => {
  const a = makeRelease({ owner: 'ada', repo: 'r1', id: 'io.github.ada.one', version: '1.0.0', thumbnails: 0 });
  const reg = makeRegistry({
    'entries/community/io.github.ada.other.json': entryFor({ id: 'io.github.ada.one', owner: 'ada', repo: 'r1', versions: [a.versionEntry] }),
    'entries/community/com.hyprune.fake.json': entryFor({ id: 'com.hyprune.fake', owner: 'ada', repo: 'r1', versions: [a.versionEntry] }),
    'entries/community/io.github.ada.bad.json': { id: 'io.github.ada.bad', type: 'world' },
  });
  const { errors } = buildIndexes({ root: reg.root });
  assert.ok(errors.some(e => /io\.github\.ada\.other\.json: file name must be io\.github\.ada\.one\.json/.test(e)));
  assert.ok(errors.some(e => /com\.hyprune\.fake\.json: com\.hyprune\.\* ids are reserved/.test(e)));
  assert.ok(errors.some(e => /io\.github\.ada\.bad\.json: .*required property/.test(e)));
});

test('tombstoned ids, versions and hashes are left out with a warning', () => {
  const v2 = makeRelease({ owner: 'ada', repo: 'r1', id: 'io.github.ada.one', version: '2.0.0', thumbnails: 0 });
  const v1 = makeRelease({ owner: 'ada', repo: 'r1', id: 'io.github.ada.one', version: '1.0.0', thumbnails: 0 });
  const c = makeRelease({ owner: 'cy', repo: 'r3', id: 'io.github.cy.gone', version: '1.0.0', thumbnails: 0 });
  const reg = makeRegistry({
    'entries/community/io.github.ada.one.json': entryFor({ id: 'io.github.ada.one', owner: 'ada', repo: 'r1', versions: [v2.versionEntry, v1.versionEntry] }),
    'entries/community/io.github.cy.gone.json': entryFor({ id: 'io.github.cy.gone', owner: 'cy', repo: 'r3', versions: [c.versionEntry] }),
    'removed/io.github.ada.one.json': { id: 'io.github.ada.one', versions: ['1.0.0'], sha256: [v1.versionEntry.sha256], reason: 'broken', date: '2026-10-01', report: 4 },
    'removed/io.github.cy.gone.json': { id: 'io.github.cy.gone', versions: '*', sha256: [c.versionEntry.sha256], reason: 'rights', date: '2026-10-01', report: 5 },
  });
  const result = buildIndexes({ root: reg.root });
  assert.deepEqual(result.errors, []);
  const entries = result.docs.community.doc.entries;
  assert.deepEqual(entries.map(e => e.id), ['io.github.ada.one']);
  assert.deepEqual(entries[0].versions.map(v => v.version), ['2.0.0']);
  assert.equal(result.warnings.length, 2);
});

test('a malformed tombstone fails the build', () => {
  const reg = makeRegistry({ 'removed/io.github.x.y.json': { id: 'io.github.x.y', versions: '*', sha256: ['NOPE'], reason: 'because', date: 'today', report: 'one' } });
  const { errors } = buildIndexes({ root: reg.root });
  assert.ok(errors.length >= 4, errors.join('\n'));
});

test('index limits: 16 MiB served size and 20,000 entries', () => {
  const doc = { indexVersion: '0.1', serial: 1, generated: '2026-10-12T00:00:00Z', entries: [] };
  assert.deepEqual(validateIndex(doc), []);
  assert.match(validateIndex(doc, { text: 'x'.repeat(limits.index.bytes + 1) }).join(), /over the 16777216 byte limit/);
  const rel = makeRelease({ owner: 'ada', repo: 'r1', id: 'io.github.ada.one', version: '1.0.0', thumbnails: 0 });
  const { $schema, ...e } = entryFor({ id: 'io.github.ada.one', owner: 'ada', repo: 'r1', versions: [rel.versionEntry] });
  const many = { ...doc, entries: Array.from({ length: limits.index.entries + 1 }, (_, i) => ({ ...e, id: `io.github.ada.e${i}` })) };
  assert.match(validateIndex(many).join(), /must NOT have more than 20000 items/);
  const dup = { ...doc, entries: [e, e] };
  assert.match(validateIndex(dup).join(), /duplicate id/);
});
