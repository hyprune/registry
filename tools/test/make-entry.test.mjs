import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGitHub } from '../test-support/fake-github.mjs';
import { makeRelease, makeRegistry } from '../test-support/fixtures.mjs';
import { makeEntry } from '../make-entry.mjs';
import { writeJson } from '../lib/common.mjs';

let gh;
before(async () => { gh = await startFakeGitHub(); Object.assign(process.env, gh.env); delete process.env.GITHUB_TOKEN; });
after(() => gh.close());

const ID = 'io.github.ada.street';
test('makes the community entry of a release and adds later versions on top', async () => {
  const v1 = makeRelease({ owner: 'ada', repo: 'hyprune-objects-street', id: ID, version: '1.0.0' });
  const v2 = makeRelease({ owner: 'ada', repo: 'hyprune-objects-street', id: ID, version: '1.1.0', thumbnails: 0 });
  gh.repos['ada/hyprune-objects-street'] = { tags: { 'v1.0.0': v1.commit, 'v1.1.0': v2.commit }, releases: [v1.release, v2.release] };
  const reg = makeRegistry();
  const first = await makeEntry(`github:ada/hyprune-objects-street@v1.0.0`, { root: reg.root, tags: ['street'] });
  assert.equal(first.file, `entries/community/${ID}.json`);
  assert.deepEqual(first.entry.versions, [v1.versionEntry]);
  assert.equal(first.entry.creator, 'ada');
  assert.deepEqual(first.entry.tags, ['street']);
  writeJson(first.path, first.entry);
  const second = await makeEntry(`github:ada/hyprune-objects-street@v1.1.0`, { root: reg.root });
  assert.deepEqual(second.entry.versions.map(v => v.tag), ['v1.1.0', 'v1.0.0']);
  assert.deepEqual(second.entry.versions[1], v1.versionEntry);
  writeJson(second.path, second.entry);
  await assert.rejects(makeEntry(`github:ada/hyprune-objects-street@v1.1.0`, { root: reg.root }), /already lists v1\.1\.0/);
  await assert.rejects(makeEntry(`github:ada/hyprune-objects-street@v9.0.0`, { root: reg.root }), /no published release/);
});
