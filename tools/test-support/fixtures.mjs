// Test fixtures: a minimal valid library package (adapted from the SDK's RFC-0011 test
// fixtures), its release assets in the RFC-0015 convention, and a scratch registry
// repository with the pinned schemas.
import { mkdirSync, writeFileSync, readFileSync, cpSync, chmodSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { defaultRoot, ENTRY_SCHEMA } from '../lib/common.mjs';

export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const fakeCommit = () => randomBytes(20).toString('hex');
export const tmp = prefix => mkdtempSync(join(tmpdir(), `hyprune-registry-${prefix}-`));

export function png(width, height) {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80); for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const positions = [-0.25, 0, -0.25, 0.25, 0, 0.25, 0, 2.5, 0.25], uvs = [0, 0, 1, 0, 0.5, 1];
const meshBin = () => { const b = Buffer.alloc(60); [...positions, ...uvs].forEach((n, i) => b.writeFloatLE(n, i * 4)); return b; };
const sceneGltf = () => ({
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'lantern', mesh: 0 }, { name: 'proxy', mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  textures: [{ source: 0 }], images: [{ uri: 'albedo.png' }], buffers: [{ uri: 'object.bin', byteLength: 60 }],
  bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.25, 0, -0.25], max: [0.25, 2.5, 0.25] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
});
const objectJson = id => ({
  formatVersion: '0.9', id, version: '1.0.0', name: 'Street lantern', category: 'lighting', tags: ['lamp'], scene: 'object.gltf', license: 'CC0-1.0',
  attribution: [{ path: '.', author: 'Example Author', license: 'CC0-1.0' }], bounds: { min: [-0.25, 0, -0.25], max: [0.25, 2.5, 0.25] }, thumbnail: 'thumbnail.png',
  lighting: { mode: 'probe' }, traits: { collidable: { node: 'proxy' }, movable: { surfaces: ['floor'], scale: [0.75, 1.5] } },
});
function writeObject(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'object.json'), JSON.stringify(objectJson(id)));
  writeFileSync(join(dir, 'object.gltf'), JSON.stringify(sceneGltf()));
  writeFileSync(join(dir, 'object.bin'), meshBin());
  writeFileSync(join(dir, 'albedo.png'), png(64, 64));
  writeFileSync(join(dir, 'thumbnail.png'), png(256, 256));
}
/** A library package directory <parent>/<id>; `extra` adds files {path: {data, mode}}. */
export function writeLibrary(parent, { id, version, name = 'Street kit', license = 'CC0-1.0', extra = {} }) {
  const dir = join(parent, id);
  writeObject(join(dir, 'objects', 'street-lantern'), 'street-lantern');
  writeFileSync(join(dir, 'LICENSE'), 'CC0-1.0\n');
  writeFileSync(join(dir, 'ATTRIBUTION.md'), '# Attribution\n');
  writeFileSync(join(dir, 'library.json'), JSON.stringify({ formatVersion: '0.9', id, version, name, license,
    attribution: [{ path: '.', author: 'Example Author', license }], objects: ['street-lantern'] }));
  for (const [path, { data, mode }] of Object.entries(extra)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), data);
    if (mode) chmodSync(join(dir, path), mode);
  }
  return dir;
}
function measure(dir) {
  let files = 0, bytes = 0;
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) walk(p); else { files++; bytes += s.size; } } };
  walk(dir);
  return { files, expandedBytes: bytes };
}
export function pack(dir, output) {
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=ustar', '--zstd', '-cf', output, '-C', join(dir, '..'), '--', dir.split('/').at(-1)], { stdio: 'pipe' });
  return readFileSync(output);
}

/**
 * A complete release of one library version: assets (archive, .sha256, record, thumbnails),
 * the record and the entry version. Options let tests break single pieces.
 */
export function makeRelease({ owner, repo, id, version, tag = `v${version}`, commit = fakeCommit(), thumbnails = 1, extra, license, name, published = '2026-10-01' }) {
  const work = tmp('pkg');
  const dir = writeLibrary(work, { id, version, extra, license, name });
  const sizes = measure(dir);
  const archive = pack(dir, join(work, `${id}-${version}.tar.zst`));
  const stem = `${id}-${version}`, hex = sha256(archive);
  const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
  const thumbs = Array.from({ length: thumbnails }, (_, i) => ({ name: `${stem}.thumb-${i + 1}.png`, data: png(320, 180) }));
  const record = {
    recordVersion: '0.1', type: 'library', id, version, formatVersion: '0.9', name: name ?? 'Street kit', license: license ?? 'CC0-1.0',
    archive: { name: `${stem}.tar.zst`, sha256: hex, bytes: archive.length, ...sizes },
    thumbnails: thumbs.map(t => ({ name: t.name, sha256: sha256(t.data), width: 320, height: 180 })),
    source: { repo: `https://github.com/${owner}/${repo}`, tag, commit },
    tool: { name: 'hyprune', version: '0.7.0' }, checks: { schema: 'pass' },
  };
  const recordData = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  const assets = [
    { name: `${stem}.tar.zst`, data: archive },
    { name: `${stem}.tar.zst.sha256`, data: Buffer.from(`${hex}  ${stem}.tar.zst\n`) },
    { name: `${stem}.release.json`, data: recordData },
    ...thumbs,
  ];
  const versionEntry = {
    tag, version, formatVersion: '0.9', published, license: record.license,
    url: `${base}/${stem}.tar.zst`, sha256: hex, bytes: archive.length, ...sizes,
    record: { url: `${base}/${stem}.release.json`, sha256: sha256(recordData) },
    ...(thumbs.length ? { thumbnails: thumbs.map(t => ({ url: `${base}/${t.name}`, sha256: sha256(t.data), width: 320, height: 180 })) } : {}),
  };
  return { assets, record, versionEntry, commit, tag, release: { tag_name: tag, published_at: `${published}T10:00:00Z`, author: { login: owner }, assets } };
}

export function entryFor({ id, owner, repo, versions, name = 'Street kit' }) {
  return { $schema: ENTRY_SCHEMA, id, type: 'library', name, summary: 'A test library.', creator: owner, repo: `https://github.com/${owner}/${repo}`, versions };
}

const gitIn = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } }).trim();

/** A scratch registry repository (schemas copied) with one commit; returns {root, commit(msg), git}. */
export function makeRegistry(files = {}) {
  const root = tmp('repo');
  cpSync(join(defaultRoot, 'schema'), join(root, 'schema'), { recursive: true });
  for (const d of ['entries/official', 'entries/community', 'removed']) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, '.gitkeep'), ''); }
  gitIn(root, 'init', '-q', '-b', 'main');
  const put = (map) => { for (const [p, v] of Object.entries(map)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); } };
  put(files);
  const commit = (msg = 'change') => { gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '--allow-empty', '-m', msg); return gitIn(root, 'rev-parse', 'HEAD'); };
  commit('base');
  return { root, put, commit, git: (...a) => gitIn(root, ...a) };
}
