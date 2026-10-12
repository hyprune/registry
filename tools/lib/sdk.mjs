// The SDK pieces the checks reuse: the safe extractor and data-only rules
// (registry/archive), world validation (world), library validation and image headers
// (object). Loaded from the built SDK checkout in HYPRUNE_REGISTRY_SDK (tools/install-sdk.sh
// in CI, a local worktree in development).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

let cached;
export async function loadSdk() {
  if (cached) return cached;
  const dir = process.env.HYPRUNE_REGISTRY_SDK;
  if (!dir) throw new Error('HYPRUNE_REGISTRY_SDK is not set: point it at a built SDK checkout (tools/install-sdk.sh <dir>)');
  const mod = async name => {
    const path = resolve(dir, 'dist/src', `${name}.js`);
    if (!existsSync(path)) throw new Error(`${path} is missing: build the SDK (npm run build) at the commit in tools/sdk.json`);
    return import(pathToFileURL(path).href);
  };
  const [archive, world, object] = await Promise.all([mod('registry/archive'), mod('world'), mod('object')]);
  cached = {
    extractArchive: archive.extractArchive,
    limitsFor: archive.limitsFor,
    validateWorld: world.validateWorld,
    validateLibrary: object.validateLibrary,
    imageHeader: object.imageHeader,
  };
  for (const [k, v] of Object.entries(cached)) if (typeof v !== 'function') throw new Error(`the SDK at ${dir} has no ${k}()`);
  return cached;
}
