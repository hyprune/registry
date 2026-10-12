// A small streaming scan of a package archive (`zstd -dc` → ustar headers): the file
// count, expanded bytes (sum of regular file sizes), the root directory names and the
// package manifest (`<root>/world.json` or `<root>/library.json`). Used by the official
// sync to fill entry sizes. It is not the safety check: the pull request checks run
// the SDK's safe extractor on every archive.
import { spawn } from 'node:child_process';

const MANIFESTS = ['world.json', 'library.json'];
const MAX_MANIFEST = 1048576;

function octal(buf, start, len) {
  if (buf[start] & 0x80) { // base-256
    let n = 0n;
    for (let i = start + 1; i < start + len; i++) n = (n << 8n) | BigInt(buf[i]);
    return Number(n);
  }
  const s = buf.toString('latin1', start, start + len).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}
const str = (buf, start, len) => buf.toString('utf8', start, start + len).replace(/\0.*$/s, '');

function paxPath(data) {
  let path;
  for (let off = 0; off < data.length;) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const len = Number(data.toString('latin1', off, sp));
    if (!len) break;
    const rec = data.toString('utf8', sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (rec.slice(0, eq) === 'path') path = rec.slice(eq + 1);
    off += len;
  }
  return path;
}

/**
 * Scan an archive. Resolves {files, expandedBytes, roots: [..], manifestName, manifest,
 * maxFileBytes}. Rejects on a malformed stream or a zstd error.
 */
export function scanArchive(path, { memory = '128MB' } = {}) {
  return new Promise((resolve, reject) => {
    const z = spawn('zstd', ['-dcq', `--memory=${memory}`, '--', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    z.stderr.on('data', d => { stderr += d; });
    let pending = Buffer.alloc(0);
    let state = { kind: 'header' };
    let nextPath, nextPathData;
    const out = { files: 0, expandedBytes: 0, maxFileBytes: 0, roots: new Set(), manifestName: null, manifest: null };
    let manifestBuf = null, ended = false, failed = null;

    function header(h) {
      if (h.every(b => b === 0)) { ended = true; return; }
      let name = str(h, 0, 100);
      const prefix = h.toString('latin1', 257, 263).startsWith('ustar') ? str(h, 345, 155) : '';
      if (prefix) name = `${prefix}/${name}`;
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      const padded = Math.ceil(size / 512) * 512;
      if (type === 'x' || type === 'L') { state = { kind: type === 'x' ? 'pax' : 'long', size, padded }; return; }
      if (type === 'g') { state = { kind: 'skip', left: padded }; return; }
      if (nextPath) { name = nextPath; nextPath = undefined; }
      const clean = name.replace(/\/+$/, '');
      const root = clean.split('/')[0];
      if (root) out.roots.add(root);
      if (type === '0' || type === '7') {
        out.files++; out.expandedBytes += size; out.maxFileBytes = Math.max(out.maxFileBytes, size);
        const rel = clean.split('/').slice(1).join('/');
        const keep = MANIFESTS.includes(rel) && size <= MAX_MANIFEST && !out.manifestName ? size : 0;
        if (keep) { out.manifestName = rel; manifestBuf = { chunks: [] }; }
        state = { kind: 'data', left: padded, keep };
      } else {
        state = { kind: 'skip', left: padded };
      }
    }

    function feed(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (!ended) {
        if (state.kind === 'header') {
          if (pending.length < 512) return;
          const h = pending.subarray(0, 512); pending = pending.subarray(512);
          header(h);
        } else if (state.kind === 'pax' || state.kind === 'long') {
          if (pending.length < state.padded) return;
          const data = pending.subarray(0, state.size); pending = pending.subarray(state.padded);
          nextPath = state.kind === 'pax' ? paxPath(data) ?? nextPath : data.toString('utf8').replace(/\0.*$/s, '');
          state = { kind: 'header' };
        } else {
          if (!pending.length) return;
          const n = Math.min(state.left, pending.length);
          if (state.kind === 'data' && state.keep > 0) {
            const take = Math.min(n, state.keep);
            manifestBuf.chunks.push(Buffer.from(pending.subarray(0, take)));
            state.keep -= take;
            if (state.keep === 0) {
              try { out.manifest = JSON.parse(Buffer.concat(manifestBuf.chunks).toString('utf8')); } catch (e) { failed = new Error(`${out.manifestName}: invalid JSON (${e.message})`); }
            }
          }
          pending = pending.subarray(n); state.left -= n;
          if (state.left === 0) state = { kind: 'header' };
        }
      }
    }

    z.stdout.on('data', chunk => { try { if (!ended) feed(chunk); } catch (e) { failed = e; z.kill(); } });
    z.on('error', reject);
    z.on('close', code => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`zstd failed (${code}): ${stderr.trim()}`));
      if (!ended && state.kind !== 'header') return reject(new Error('truncated tar stream'));
      resolve({ ...out, roots: [...out.roots] });
    });
  });
}
