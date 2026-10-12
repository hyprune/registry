import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startFakeGitHub } from '../test-support/fake-github.mjs';
import { makeRelease, makeRegistry, entryFor, tmp } from '../test-support/fixtures.mjs';
import { scope, fetchFacts, verify, classify } from '../check-pr.mjs';

const needsSdk = process.env.HYPRUNE_REGISTRY_SDK ? {} : { skip: 'HYPRUNE_REGISTRY_SDK is not set (a built SDK checkout)' };
let gh;
before(async () => {
  gh = await startFakeGitHub();
  Object.assign(process.env, gh.env);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_STEP_SUMMARY;
});
after(() => gh.close());

const ID = 'io.github.ada.street';
/** A published release on the fake GitHub plus a registry with the entry change committed. */
function scenario({ owner = 'ada', repo = 'hyprune-objects-street', id = ID, version = '1.2.0', release = {}, repoInfo = {}, base = {}, entry, mutateEntry, extraFiles, file } = {}) {
  const rel = makeRelease({ owner, repo, id, version, extra: extraFiles, ...release });
  const key = `${owner}/${repo}`;
  const existing = gh.repos[key];
  gh.repos[key] = {
    owner: { login: owner, type: 'User' }, name: repo, topics: ['hyprune', 'hyprune-objects'], permissions: { [owner]: 'admin' },
    ...existing, ...repoInfo,
    tags: { ...existing?.tags, [rel.tag]: rel.commit, ...repoInfo.tags },
    releases: [...(existing?.releases ?? []).filter(r => r.tag_name !== rel.tag), rel.release],
  };
  const reg = makeRegistry(base);
  const baseRev = reg.git('rev-parse', 'HEAD');
  const e = entry ?? entryFor({ id, owner, repo, versions: [rel.versionEntry] });
  mutateEntry?.(e, rel);
  reg.put({ [file ?? `entries/community/${id}.json`]: e });
  reg.commit('add entry');
  return { reg, baseRev, rel, entry: e };
}

async function run(s, { author = 'ada', association = 'NONE', headRef = 'add-entry' } = {}) {
  const work = tmp('work');
  const plan = scope({ root: s.reg.root, base: s.baseRev, author, association, headRef });
  if (plan.mode && plan.items.length) await fetchFacts(plan, work);
  const outcome = await verify(plan, work, { root: s.reg.root });
  rmSync(work, { recursive: true, force: true });
  outcome.failed = outcome.results.filter(r => !r.ok).map(r => r.check);
  outcome.messages = outcome.results.filter(r => !r.ok).map(r => `${r.check}: ${r.message}`).join('\n');
  return outcome;
}

test('a valid new entry passes all 14 checks', needsSdk, async () => {
  const out = await run(scenario());
  assert.deepEqual(out.failed, [], out.messages);
  for (let c = 1; c <= 14; c++) assert.ok(out.results.some(r => r.check === c && r.ok), `check ${c} ran`);
  assert.deepEqual(out.warnings.filter(w => /repository name/.test(w)), []);
  assert.deepEqual(out.hints, []);
});

test('the PR author needs write access to the repository', needsSdk, async () => {
  const out = await run(scenario({ repo: 'hyprune-objects-perm' }), { author: 'mallory' });
  assert.deepEqual(out.failed, [2], out.messages);
  assert.match(out.messages, /can't confirm that mallory has write access/);
});

test('write access is accepted from the release author when the permission API is forbidden', needsSdk, async () => {
  const s = scenario({ repo: 'hyprune-objects-forbid', repoInfo: { forbidPermission: true }, release: {} });
  s.rel.release.author = { login: 'ada-helper' };
  assert.deepEqual((await run(s, { author: 'ada-helper' })).failed, []);
  assert.deepEqual((await run(s, { author: 'someone-else' })).failed, [2]);
});

test('write access from the collaborator permission API', needsSdk, async () => {
  const s = scenario({ repo: 'hyprune-objects-collab', repoInfo: { permissions: { ada: 'admin', bea: 'write', cy: 'read' } } });
  s.rel.release.author = { login: 'ada' };
  assert.deepEqual((await run(s, { author: 'bea' })).failed, []);
  assert.deepEqual((await run(s, { author: 'cy' })).failed, [2]);
});

test('com.hyprune.* ids are reserved for official entries', needsSdk, async () => {
  const out = await run(scenario({ id: 'com.hyprune.street', repo: 'hyprune-objects-reserved' }));
  assert.ok(out.failed.includes(2), out.messages);
  assert.match(out.messages, /reserved for official entries/);
});

test('io.github.<owner> ids need a repository of that owner', needsSdk, async () => {
  const out = await run(scenario({ id: 'io.github.bob.street', repo: 'hyprune-objects-owner' }));
  assert.ok(out.failed.includes(2), out.messages);
  assert.match(out.messages, /io\.github\.bob\.\* ids belong to repositories of bob/);
});

test('the tag must point to the record commit', needsSdk, async () => {
  const s = scenario({ repo: 'hyprune-objects-tag' });
  gh.repos['ada/hyprune-objects-tag'].tags['v1.2.0'] = { annotated: 'a'.repeat(40), commit: 'b'.repeat(40) };
  const out = await run(s);
  assert.deepEqual(out.failed, [3], out.messages);
  assert.match(out.messages, /points to b{40}, the record says/);
  // An annotated tag that peels to the record's commit passes.
  gh.repos['ada/hyprune-objects-tag'].tags['v1.2.0'] = { annotated: 'c'.repeat(40), commit: s.rel.commit };
  assert.deepEqual((await run(s)).failed, []);
});

test('a missing tag or a tag that names another version fails check 3', needsSdk, async () => {
  const s = scenario({ repo: 'hyprune-objects-notag' });
  delete gh.repos['ada/hyprune-objects-notag'].tags['v1.2.0'];
  assert.ok((await run(s)).failed.includes(3));
});

test('a pre-release version needs a release marked as pre-release', needsSdk, async () => {
  const s = scenario({ repo: 'hyprune-objects-pre', version: '2.0.0-rc.1' });
  const out = await run(s);
  assert.deepEqual(out.failed, [3], out.messages);
  s.rel.release.prerelease = true;
  assert.deepEqual((await run(s)).failed, []);
});

test('an archive hash that differs from the entry fails check 5', needsSdk, async () => {
  const out = await run(scenario({ repo: 'hyprune-objects-hash', mutateEntry: e => { e.versions[0].sha256 = 'f'.repeat(64); } }));
  assert.ok(out.failed.includes(5), out.messages);
  assert.ok(!out.failed.includes(4));
});

test('a replaced asset and a changed listed version fail check 14', needsSdk, async () => {
  const first = makeRelease({ owner: 'ada', repo: 'hyprune-objects-hist', id: ID, version: '1.0.0' });
  const baseEntry = entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-hist', versions: [first.versionEntry] });
  const s = scenario({
    repo: 'hyprune-objects-hist', version: '1.1.0', base: { [`entries/community/${ID}.json`]: baseEntry },
    mutateEntry: (e, rel) => { e.versions = [rel.versionEntry, { ...first.versionEntry, sha256: 'e'.repeat(64) }]; },
  });
  const out = await run(s);
  assert.deepEqual(out.failed, [14], out.messages);
  assert.match(out.messages, /1\.0\.0: sha256 changed/);
});

test('a listed version may not disappear and a new version must be added', async () => {
  const first = makeRelease({ owner: 'ada', repo: 'hyprune-objects-gone', id: ID, version: '1.0.0', thumbnails: 0 });
  const second = makeRelease({ owner: 'ada', repo: 'hyprune-objects-gone', id: ID, version: '1.1.0', thumbnails: 0 });
  const reg = makeRegistry({ [`entries/community/${ID}.json`]: entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-gone', versions: [second.versionEntry, first.versionEntry] }) });
  const base = reg.git('rev-parse', 'HEAD');
  reg.put({ [`entries/community/${ID}.json`]: entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-gone', versions: [second.versionEntry] }) });
  reg.commit();
  const plan = scope({ root: reg.root, base, author: 'ada' });
  const fails = plan.results.filter(r => !r.ok);
  assert.ok(fails.some(r => r.check === 14 && /1\.0\.0 disappeared/.test(r.message)));
  assert.ok(fails.some(r => r.check === 14 && /adds no version/.test(r.message)));
});

test('a tombstoned archive hash, version or id is refused (check 13)', needsSdk, async () => {
  const rel = makeRelease({ owner: 'ada', repo: 'hyprune-objects-tomb', id: ID, version: '1.2.0' });
  const tomb = { id: 'io.github.zed.copy', versions: '*', sha256: [rel.versionEntry.sha256], reason: 'rights', date: '2026-10-01', report: 12 };
  const s = scenario({ repo: 'hyprune-objects-tomb', base: { 'removed/io.github.zed.copy.json': tomb }, entry: entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-tomb', versions: [rel.versionEntry] }) });
  // scenario() made a fresh release; publish the tombstoned bytes instead.
  gh.repos['ada/hyprune-objects-tomb'].releases = [rel.release];
  gh.repos['ada/hyprune-objects-tomb'].tags = { 'v1.2.0': rel.commit };
  const out = await run(s);
  assert.deepEqual(out.failed, [13], out.messages);
  assert.match(out.messages, /was removed with io\.github\.zed\.copy \(rights/);
  // A tombstoned id.
  const s2 = scenario({ repo: 'hyprune-objects-tomb2', base: { [`removed/${ID}.json`]: { id: ID, versions: '*', sha256: [], reason: 'policy', date: '2026-10-01', report: 3 } } });
  assert.ok((await run(s2)).failed.includes(13));
});

test('a pull request touching two files fails the scope', async () => {
  const reg = makeRegistry();
  const base = reg.git('rev-parse', 'HEAD');
  reg.put({ [`entries/community/${ID}.json`]: { id: ID }, 'README.md': 'changed\n' });
  reg.commit();
  const plan = scope({ root: reg.root, base, author: 'ada' });
  assert.equal(plan.items.length, 0);
  assert.ok(plan.results.some(r => r.check === 0 && !r.ok && /exactly one entries\/community/.test(r.message)));
});

test('official entries change only through the sync job', () => {
  const files = [{ status: 'M', path: 'entries/official/com.hyprune.x.json' }];
  assert.match(classify(files, { author: 'ada', headRef: 'sync-official/x' }).errors.join(), /only through the official sync job/);
  assert.deepEqual(classify(files, { author: 'github-actions[bot]', headRef: 'sync-official/2026-10-12' }), { mode: 'official', errors: [] });
  assert.match(classify(files, { author: 'github-actions[bot]', headRef: 'other' }).errors.join(), /only through the official sync job/);
  const two = [{ status: 'A', path: 'entries/community/a.b.json' }, { status: 'A', path: 'tools/x.mjs' }];
  assert.match(classify(two, { author: 'ada' }).errors.join(), /exactly one/);
});

test('an executable or non-data file in the archive fails check 8', needsSdk, async () => {
  const out = await run(scenario({ repo: 'hyprune-objects-exec', extraFiles: { 'tools/run.sh': { data: '#!/bin/sh\necho hi\n', mode: 0o755 } } }));
  assert.ok(out.failed.includes(8), out.messages);
  assert.ok(!out.failed.includes(7));
  const out2 = await run(scenario({ repo: 'hyprune-objects-exec2', extraFiles: { 'notes.json': { data: '{}', mode: 0o755 } } }));
  assert.ok(out2.failed.includes(8), out2.messages);
  assert.match(out2.messages, /executable mode bit/);
});

test('a non-conforming repository name only warns; missing topics give a hint', needsSdk, async () => {
  const out = await run(scenario({ repo: 'street-things', repoInfo: { topics: [] } }));
  assert.deepEqual(out.failed, [], out.messages);
  assert.ok(out.warnings.some(w => /repository name "street-things" doesn't follow/.test(w)));
  assert.ok(out.hints.some(h => /topics hyprune and hyprune-objects/.test(h)));
  // Monorepos (tags <name>-v<version>) are exempt.
  const mono = await run(scenario({ repo: 'my-packages', release: { tag: 'street-v1.2.0' } }));
  assert.deepEqual(mono.failed, [], mono.messages);
  assert.ok(!mono.warnings.some(w => /repository name/.test(w)));
});

test('record, entry and manifest must agree (check 6) and thumbnails must match (check 12)', needsSdk, async () => {
  const out = await run(scenario({ repo: 'hyprune-objects-agree', mutateEntry: e => { e.versions[0].files += 1; e.versions[0].thumbnails[0].width = 640; } }));
  assert.deepEqual(out.failed.sort((a, b) => a - b), [6, 12], out.messages);
});

test('a library entry that requires libraries fails check 1', needsSdk, async () => {
  const out = await run(scenario({ repo: 'hyprune-objects-req', mutateEntry: e => { e.versions[0].requires = { libraries: ['com.hyprune.street@9.9.9'] }; } }));
  // A library requiring libraries is invalid already (check 1); the version is not downloaded.
  assert.ok(out.failed.includes(1), out.messages);
});

test('a removal with a tombstone by a maintainer passes; by others it fails', async () => {
  const rel = makeRelease({ owner: 'ada', repo: 'hyprune-objects-rm', id: ID, version: '1.0.0', thumbnails: 0 });
  const reg = makeRegistry({ [`entries/community/${ID}.json`]: entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-rm', versions: [rel.versionEntry] }) });
  const base = reg.git('rev-parse', 'HEAD');
  reg.git('rm', '-q', `entries/community/${ID}.json`);
  reg.put({ [`removed/${ID}.json`]: { id: ID, versions: '*', sha256: [rel.versionEntry.sha256], reason: 'rights', date: '2026-10-12', report: 7 } });
  reg.commit();
  const ok = scope({ root: reg.root, base, author: 'maint', association: 'MEMBER' });
  assert.equal(ok.mode, 'removal');
  assert.deepEqual(ok.results.filter(r => !r.ok), []);
  const bad = scope({ root: reg.root, base, author: 'someone', association: 'NONE' });
  assert.ok(bad.results.some(r => r.check === 0 && !r.ok));
});

test('the re-verification may only change status', async () => {
  const rel = makeRelease({ owner: 'ada', repo: 'hyprune-objects-rv', id: ID, version: '1.0.0', thumbnails: 0 });
  const e = entryFor({ id: ID, owner: 'ada', repo: 'hyprune-objects-rv', versions: [rel.versionEntry] });
  const reg = makeRegistry({ [`entries/community/${ID}.json`]: e });
  const base = reg.git('rev-parse', 'HEAD');
  reg.put({ [`entries/community/${ID}.json`]: { ...e, versions: [{ ...rel.versionEntry, status: 'unavailable' }] }, 'state/reverify.json': { version: 1, entries: {} } });
  reg.commit();
  const plan = scope({ root: reg.root, base, author: 'github-actions[bot]', headRef: 'reverify/2026-10-12' });
  assert.equal(plan.mode, 'reverify');
  assert.deepEqual(plan.results.filter(r => !r.ok), []);
  reg.put({ [`entries/community/${ID}.json`]: { ...e, name: 'Renamed', versions: [{ ...rel.versionEntry, status: 'unavailable' }] } });
  reg.commit();
  const bad = scope({ root: reg.root, base, author: 'github-actions[bot]', headRef: 'reverify/2026-10-12' });
  assert.ok(bad.results.some(r => r.check === 14 && !r.ok));
});

test('an entry that is not valid JSON fails check 1 without downloads', async () => {
  const reg = makeRegistry();
  const base = reg.git('rev-parse', 'HEAD');
  reg.put({ [`entries/community/${ID}.json`]: '{ nope' });
  reg.commit();
  const plan = scope({ root: reg.root, base, author: 'ada' });
  assert.equal(plan.items.length, 0);
  assert.ok(plan.results.some(r => r.check === 1 && !r.ok && /not valid JSON/.test(r.message)));
});

test('the GitHub token is sent to the API only', needsSdk, async () => {
  process.env.GITHUB_TOKEN = 'read-only-token';
  try {
    gh.log.length = 0;
    await run(scenario({ repo: 'hyprune-objects-token' }));
    assert.ok(gh.log.some(l => l.path.startsWith('/api/') && l.auth === 'Bearer read-only-token'));
    assert.ok(gh.log.filter(l => l.path.startsWith('/dl/')).every(l => l.auth === null));
  } finally { delete process.env.GITHUB_TOKEN; }
});


test('changes outside entries/, removed/ and state/ are maintenance', () => {
  assert.deepEqual(classify([{ status: 'M', path: 'tools/check-pr.mjs' }, { status: 'M', path: 'README.md' }], { author: 'ada' }), { mode: 'maintenance', errors: [] });
  assert.match(classify([{ status: 'M', path: 'tools/x.mjs' }, { status: 'A', path: 'entries/community/a.b.json' }], { author: 'ada' }).errors.join(), /exactly one/);
});
