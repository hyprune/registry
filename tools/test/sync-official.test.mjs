import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGitHub } from '../test-support/fake-github.mjs';
import { makeRelease, makeRegistry } from '../test-support/fixtures.mjs';
import { syncOfficial, nixHashOf, summarize } from '../sync-official.mjs';
import { githubClient } from '../lib/github.mjs';
import { validateEntry } from '../lib/validate.mjs';

let gh;
before(async () => { gh = await startFakeGitHub(); Object.assign(process.env, gh.env); delete process.env.GITHUB_TOKEN; });
after(() => gh.close());

const ID = 'com.hyprune.kit';
const pin = rel => ({ id: ID, version: rel.record.version, formatVersion: '0.9', url: rel.versionEntry.url, sha256: rel.versionEntry.sha256, nixHash: nixHashOf(rel.versionEntry.sha256), published: true });
function publish(rel, { record = true } = {}) {
  const repo = (gh.repos['hyprune/worlds'] ??= { owner: { login: 'hyprune', type: 'Organization' }, tags: {}, releases: [] });
  repo.tags[rel.tag] = rel.commit;
  repo.releases.push({ ...rel.release, assets: rel.release.assets.filter(a => record || !a.name.endsWith('.release.json')) });
}
const pins = (libraries, worlds = {}, optional = undefined) => {
  gh.files['/raw/libraries.json'] = JSON.stringify(libraries);
  gh.files['/raw/worlds.json'] = JSON.stringify(worlds);
  if (optional) gh.files['/raw/optional.json'] = JSON.stringify(optional);
  return { world: `${gh.url}/raw/worlds.json`, library: `${gh.url}/raw/libraries.json`, ...(optional ? { optional: `${gh.url}/raw/optional.json` } : {}) };
};

test('writes an official entry from the pins, with the release record and thumbnails', async () => {
  const rel = makeRelease({ owner: 'hyprune', repo: 'worlds', id: ID, version: '0.1.0', tag: 'kit-v0.1.0', name: 'Hyprune kit' });
  publish(rel);
  const reg = makeRegistry();
  const out = await syncOfficial({ root: reg.root, pins: pins({ kit: pin(rel) }), gh: githubClient() });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.changed, [`entries/official/${ID}.json`]);
  const entry = JSON.parse(readFileSync(join(reg.root, 'entries/official', `${ID}.json`), 'utf8'));
  assert.deepEqual(validateEntry(entry), []);
  assert.equal(entry.creator, 'hyprune');
  assert.equal(entry.repo, 'https://github.com/hyprune/worlds');
  assert.equal(entry.name, 'Hyprune kit');
  const { status, ...v } = entry.versions[0];
  assert.deepEqual(v, { ...rel.versionEntry, published: '2026-10-01' });
  // A second run changes nothing.
  const again = await syncOfficial({ root: reg.root, pins: pins({ kit: pin(rel) }), gh: githubClient() });
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.errors, []);
});

test('a new pin version is added newest first; listed versions are kept and never re-pointed', async () => {
  const old = makeRelease({ owner: 'hyprune', repo: 'worlds', id: ID, version: '0.2.0', tag: 'kit-v0.2.0', thumbnails: 0 });
  publish(old, { record: false });
  const reg = makeRegistry();
  let out = await syncOfficial({ root: reg.root, pins: pins({ kit: pin(old) }), gh: githubClient() });
  assert.deepEqual(out.errors, []);
  assert.match(out.notes.join('\n'), /imported from the pin without a record/);
  const path = join(reg.root, 'entries/official', `${ID}.json`);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).versions[0].record, undefined);
  const next = makeRelease({ owner: 'hyprune', repo: 'worlds', id: ID, version: '0.3.0', tag: 'kit-v0.3.0', thumbnails: 0 });
  publish(next);
  out = await syncOfficial({ root: reg.root, pins: pins({ kit: pin(next) }), gh: githubClient() });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).versions.map(v => v.tag), ['kit-v0.3.0', 'kit-v0.2.0']);
  // Re-pointing a listed version to other bytes is refused.
  const before = readFileSync(path, 'utf8');
  out = await syncOfficial({ root: reg.root, pins: pins({ kit: { ...pin(next), sha256: 'a'.repeat(64), nixHash: nixHashOf('a'.repeat(64)) } }), gh: githubClient() });
  assert.match(out.errors.join(), /already listed/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('pins whose sha256, nixHash, tag or archive disagree are refused', async () => {
  const rel = makeRelease({ owner: 'hyprune', repo: 'worlds', id: ID, version: '0.4.0', tag: 'kit-v0.4.0', thumbnails: 0 });
  publish(rel);
  const reg = makeRegistry();
  const check = async (p, re) => {
    const out = await syncOfficial({ root: reg.root, pins: pins({ kit: p }), gh: githubClient() });
    assert.match(out.errors.join('\n'), re);
    assert.deepEqual(out.changed, []);
  };
  await check({ ...pin(rel), nixHash: nixHashOf('b'.repeat(64)) }, /nixHash .* doesn't match sha256/);
  await check({ ...pin(rel), sha256: 'c'.repeat(64), nixHash: nixHashOf('c'.repeat(64)) }, /downloaded archive sha256 .* differs from the pin/);
  await check({ ...pin(rel), version: '0.4.1' }, /asset .* must be com\.hyprune\.kit-0\.4\.1\.tar\.zst/);
  await check({ ...pin(rel), url: rel.versionEntry.url.replace('kit-v0.4.0', 'kit-v9.9.9') }, /doesn't name version 0\.4\.0/);
  // Unpublished pins are skipped.
  const out = await syncOfficial({ root: reg.root, pins: pins({ kit: { ...pin(rel), published: false } }), gh: githubClient() });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.changed, []);
});

test('summaries stay within 140 characters', () => {
  assert.equal(summarize('Short.'), 'Short.');
  const long = 'A grand blue-hour transit terminal for six permanent project docks. Files arrive as cargo; applications dock as screens, beneath a bronze vault.';
  assert.equal(summarize(long), 'A grand blue-hour transit terminal for six permanent project docks.');
  const words = 'word '.repeat(60);
  const s = summarize(words);
  assert.ok(s.length <= 140 && s.endsWith('…'));
});

test('optional library pins (libraries/optional.json) become official library entries too', async () => {
  const OPT = 'com.hyprune.extras';
  const rel = makeRelease({ owner: 'hyprune', repo: 'worlds', id: OPT, version: '0.1.0', tag: 'extras-v0.1.0', name: 'Hyprune extras' });
  publish(rel);
  const reg = makeRegistry();
  const optPin = { ...pin(rel), id: OPT };
  const out = await syncOfficial({ root: reg.root, pins: pins({}, {}, { [`${OPT}@0.1.0`]: optPin }), gh: githubClient() });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.changed, [`entries/official/${OPT}.json`]);
  const entry = JSON.parse(readFileSync(join(reg.root, 'entries/official', `${OPT}.json`), 'utf8'));
  assert.equal(entry.type, 'library');
  assert.deepEqual(validateEntry(entry), []);
  // Without an optional source nothing else is read.
  const none = await syncOfficial({ root: reg.root, pins: pins({}, {}), gh: githubClient() });
  assert.deepEqual(none.errors, []);
});
