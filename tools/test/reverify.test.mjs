import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGitHub } from '../test-support/fake-github.mjs';
import { makeRelease, makeRegistry, entryFor } from '../test-support/fixtures.mjs';
import { reverify } from '../reverify.mjs';
import { githubClient } from '../lib/github.mjs';

let gh;
before(async () => { gh = await startFakeGitHub(); Object.assign(process.env, gh.env); delete process.env.GITHUB_TOKEN; });
after(() => gh.close());

const ID = 'io.github.ada.street';
function setup(repo) {
  const v2 = makeRelease({ owner: 'ada', repo, id: ID, version: '2.0.0' });
  const v1 = makeRelease({ owner: 'ada', repo, id: ID, version: '1.0.0', thumbnails: 0 });
  gh.repos[`ada/${repo}`] = { tags: { 'v2.0.0': v2.commit, 'v1.0.0': v1.commit }, releases: [v2.release, v1.release] };
  const entry = entryFor({ id: ID, owner: 'ada', repo, versions: [v2.versionEntry, v1.versionEntry] });
  const reg = makeRegistry({ [`entries/community/${ID}.json`]: entry });
  return { reg, v1, v2, file: join(reg.root, 'entries/community', `${ID}.json`) };
}
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const client = () => githubClient();

test('verified versions stay available; tag commits are remembered', async () => {
  const { reg, v1, v2, file } = setup('rv-ok');
  const out = await reverify({ root: reg.root, gh: client(), date: '2026-10-12' });
  assert.deepEqual(out.marked, []);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.changed, ['state/reverify.json']);
  assert.ok(read(file).versions.every(v => v.status === undefined));
  const state = read(join(reg.root, 'state/reverify.json'));
  assert.equal(state.entries[ID]['v1.0.0'].commit, v1.commit);
  assert.equal(state.entries[ID]['v2.0.0'].commit, v2.commit);
});

test('a missing asset, a replaced asset and a moved tag mark versions unavailable', async () => {
  const { reg, v1, file } = setup('rv-bad');
  await reverify({ root: reg.root, gh: client(), date: '2026-10-01' });
  const repo = gh.repos['ada/rv-bad'];
  // v2: the archive is replaced by different bytes of the same size.
  const a2 = repo.releases[0].assets[0];
  a2.data = Buffer.from(a2.data); a2.data[a2.data.length - 1] ^= 0xff;
  // v1 (no record): the tag moves to another commit.
  repo.tags['v1.0.0'] = 'd'.repeat(40);
  const out = await reverify({ root: reg.root, gh: client(), date: '2026-10-05' });
  assert.equal(out.marked.length, 2, out.marked.join('\n'));
  assert.match(out.marked.join('\n'), /v2\.0\.0: archive hash changed/);
  assert.match(out.marked.join('\n'), /v1\.0\.0: tag v1\.0\.0 moved/);
  assert.deepEqual(read(file).versions.map(v => v.status), ['unavailable', 'unavailable']);
  const state = read(join(reg.root, 'state/reverify.json'));
  assert.equal(state.entries[ID]['v2.0.0'].unavailableSince, '2026-10-05');
  // Moving the tag back makes v1 available again; v2 stays unavailable.
  repo.tags['v1.0.0'] = v1.commit;
  const again = await reverify({ root: reg.root, gh: client(), date: '2026-10-12' });
  assert.deepEqual(again.restored, [`${ID} v1.0.0`]);
  assert.deepEqual(read(file).versions.map(v => v.status), ['unavailable', undefined]);
});

test('a deleted asset or tag marks unavailable; after 30 days the entry is removed with a tombstone', async () => {
  const { reg, v1, v2, file } = setup('rv-gone');
  const repo = gh.repos['ada/rv-gone'];
  repo.releases[0].assets = repo.releases[0].assets.filter(a => !a.name.endsWith('.tar.zst'));
  delete repo.tags['v1.0.0'];
  const out = await reverify({ root: reg.root, gh: client(), date: '2026-10-01' });
  assert.match(out.marked.join('\n'), /v2\.0\.0: archive asset is gone/);
  assert.match(out.marked.join('\n'), /v1\.0\.0: tag v1\.0\.0 was deleted/);
  const day29 = await reverify({ root: reg.root, gh: client(), date: '2026-10-30' });
  assert.deepEqual(day29.removed, []);
  assert.ok(existsSync(file));
  const day30 = await reverify({ root: reg.root, gh: client(), date: '2026-10-31' });
  assert.equal(day30.removed.length, 1);
  assert.ok(!existsSync(file));
  const tomb = read(join(reg.root, 'removed', `${ID}.json`));
  assert.deepEqual(tomb, { id: ID, versions: '*', sha256: [v2.versionEntry.sha256, v1.versionEntry.sha256], reason: 'unavailable', date: '2026-10-31', report: null });
  assert.deepEqual(read(join(reg.root, 'state/reverify.json')).entries, {});
});

test('official entries are marked but never removed', async () => {
  const rel = makeRelease({ owner: 'hyprune', repo: 'worlds', id: 'com.hyprune.kit', version: '0.1.0', tag: 'kit-v0.1.0', thumbnails: 0 });
  gh.repos['hyprune/worlds'] = { tags: {}, releases: [] };
  const reg = makeRegistry({ 'entries/official/com.hyprune.kit.json': entryFor({ id: 'com.hyprune.kit', owner: 'hyprune', repo: 'worlds', versions: [rel.versionEntry] }) });
  await reverify({ root: reg.root, gh: client(), date: '2026-01-01' });
  const out = await reverify({ root: reg.root, gh: client(), date: '2026-12-01' });
  assert.deepEqual(out.removed, []);
  assert.equal(read(join(reg.root, 'entries/official/com.hyprune.kit.json')).versions[0].status, 'unavailable');
});

test('network failures mark nothing', async () => {
  const { reg, file } = setup('rv-net');
  const saved = process.env.HYPRUNE_GITHUB_DOWNLOAD;
  process.env.HYPRUNE_GITHUB_DOWNLOAD = 'http://127.0.0.1:9/dl';
  try {
    const out = await reverify({ root: reg.root, gh: client(), date: '2026-10-12' });
    assert.deepEqual(out.marked, []);
    assert.equal(out.skipped.length, 2);
    assert.ok(read(file).versions.every(v => v.status === undefined));
  } finally { process.env.HYPRUNE_GITHUB_DOWNLOAD = saved; }
});
