// A fake GitHub for the registry tool tests: the REST API under /api and release
// downloads under /dl, on 127.0.0.1. Use with
//   HYPRUNE_GITHUB_API=<url>/api  HYPRUNE_GITHUB_DOWNLOAD=<url>/dl
//   HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1
// State (mutable between requests):
//   repos['owner/name'] = { owner: {login, type}, name, topics, private,
//     permissions: {login: 'write'|…}, forbidPermission,      // 403 like a token without push access
//     tags: {tag: commitSha | {annotated: tagObjectSha, commit}},
//     releases: [{tag_name, draft, prerelease, published_at, author: {login},
//                 assets: [{name, data: Buffer, contentLength?}]}] }
//   files['/raw/path'] = Buffer | string   (static files, e.g. pins)
import { createServer } from 'node:http';

export async function startFakeGitHub({ repos = {}, files = {} } = {}) {
  const log = [];
  const send = (res, status, body, headers = {}) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-length': data.length, 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
    res.end(data);
  };
  const releaseJson = (o, r, rel) => ({
    tag_name: rel.tag_name, draft: !!rel.draft, prerelease: !!rel.prerelease,
    published_at: rel.published_at ?? '2026-10-01T10:00:00Z', created_at: rel.published_at ?? '2026-10-01T10:00:00Z',
    author: rel.author ?? { login: o }, assets: (rel.assets ?? []).map(a => ({
      name: a.name, size: a.data.length, browser_download_url: `https://github.com/${o}/${r}/releases/download/${rel.tag_name}/${a.name}`,
    })),
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    log.push({ method: req.method, path, auth: req.headers.authorization ?? null });
    let m;
    if (files[path] !== undefined) return send(res, 200, Buffer.from(files[path]));
    if ((m = /^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname))) {
      const [o, r] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const repo = repos[`${o}/${r}`];
      if (!repo || repo.private) return send(res, 404, { message: 'Not Found' });
      const rest = m[3] ? decodeURIComponent(m[3]) : '';
      if (!rest) return send(res, 200, { name: repo.name ?? r, full_name: `${repo.owner?.login ?? o}/${repo.name ?? r}`, owner: repo.owner ?? { login: o, type: 'User' }, topics: repo.topics ?? [], private: false });
      if (rest === '/releases') {
        const page = Number(url.searchParams.get('page') ?? 1), per = Number(url.searchParams.get('per_page') ?? 30);
        const list = (repo.releases ?? []).filter(x => !x.draft).map(x => releaseJson(o, r, x));
        return send(res, 200, list.slice((page - 1) * per, page * per));
      }
      if ((m = /^\/releases\/tags\/(.+)$/.exec(rest))) {
        const rel = (repo.releases ?? []).find(x => x.tag_name === m[1] && !x.draft);
        return rel ? send(res, 200, releaseJson(o, r, rel)) : send(res, 404, { message: 'Not Found' });
      }
      if ((m = /^\/git\/ref\/tags\/(.+)$/.exec(rest))) {
        const t = repo.tags?.[m[1]];
        if (!t) return send(res, 404, { message: 'Not Found' });
        const object = typeof t === 'string' ? { type: 'commit', sha: t } : { type: 'tag', sha: t.annotated };
        return send(res, 200, { ref: `refs/tags/${m[1]}`, object });
      }
      if ((m = /^\/git\/tags\/([0-9a-f]+)$/.exec(rest))) {
        const t = Object.values(repo.tags ?? {}).find(x => typeof x === 'object' && x.annotated === m[1]);
        return t ? send(res, 200, { sha: m[1], object: { type: 'commit', sha: t.commit } }) : send(res, 404, { message: 'Not Found' });
      }
      if ((m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest))) {
        if (repo.forbidPermission) return send(res, 403, { message: 'Must have push access to view collaborator permission.' });
        const p = repo.permissions?.[m[1]] ?? 'none';
        return send(res, 200, { permission: p === 'maintain' ? 'write' : p, role_name: p, user: { login: m[1] } });
      }
      return send(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/dl\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
      const [o, r, tag, name] = m.slice(1).map(decodeURIComponent);
      const repo = repos[`${o}/${r}`];
      const rel = repo?.releases?.find(x => x.tag_name === tag && !x.draft);
      const asset = rel?.assets?.find(a => a.name === name);
      if (!asset) return send(res, 404, 'Not Found');
      if (asset.contentLength !== undefined) {
        // A lying Content-Length: send headers by hand.
        res.writeHead(200, { 'content-length': asset.contentLength, 'content-type': 'application/octet-stream' });
        return res.end(asset.data.subarray(0, Math.min(asset.data.length, asset.contentLength)));
      }
      return send(res, 200, asset.data);
    }
    send(res, 404, 'Not Found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, api: `${url}/api`, download: `${url}/dl`, repos, files, log,
    env: { HYPRUNE_GITHUB_API: `${url}/api`, HYPRUNE_GITHUB_DOWNLOAD: `${url}/dl`, HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP: '1' },
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}
