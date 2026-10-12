// Repository naming convention (recommended, never required):
//   <owner>/hyprune-<kind>-<name>, kinds world, objects, companion, extension, shell,
//   with the GitHub topics `hyprune` and `hyprune-<kind>`.
// Repositories holding several packages (tags `<name>-v<version>`) are exempt.
// The registry only warns; custom sources are never checked.
import { tagVersion } from './validate.mjs';

export const KINDS = ['world', 'objects', 'companion', 'extension', 'shell'];
const KINDS_FOR_TYPE = { world: ['world'], library: ['objects', 'companion'] };
const NAME_RE = new RegExp(`^hyprune-(${KINDS.join('|')})-([a-z0-9]+(?:-[a-z0-9]+)*)$`);

/** Whether an entry comes from a repository with several packages (`<name>-v<version>` tags). */
export const isMonorepo = entry => entry.versions.some(v => tagVersion(v.tag)?.name);

/**
 * Warnings and hints for an entry's repository name and topics.
 * `topics` (optional) is the repository's topic list from the API.
 * Returns {warnings: [..], hints: [..]}.
 */
export function namingAdvice(entry, repoName, topics) {
  const warnings = [], hints = [];
  if (!repoName || isMonorepo(entry)) return { warnings, hints };
  const m = NAME_RE.exec(repoName);
  const suggested = KINDS_FOR_TYPE[entry.type][0];
  const slug = entry.id.split('.').at(-1);
  if (!m) {
    warnings.push(`repository name "${repoName}" doesn't follow the recommended hyprune-<kind>-<name> (for example hyprune-${suggested}-${slug}); this is only a recommendation`);
  } else if (!KINDS_FOR_TYPE[entry.type].includes(m[1])) {
    warnings.push(`repository kind "${m[1]}" doesn't match a ${entry.type} package (use ${KINDS_FOR_TYPE[entry.type].join(' or ')}); this is only a recommendation`);
  }
  if (Array.isArray(topics)) {
    const kind = m && KINDS_FOR_TYPE[entry.type].includes(m[1]) ? m[1] : suggested;
    const missing = ['hyprune', `hyprune-${kind}`].filter(t => !topics.includes(t));
    if (missing.length) hints.push(`add the GitHub topic${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} to the repository so people can find it`);
  }
  return { warnings, hints };
}
