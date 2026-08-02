// Autopilot lane naming helpers — shared by stack-autopilot.mjs and lane.test.mjs.

// Converts an item title to a git-safe slug: lowercase, alphanumeric runs
// joined by hyphens, trailing hyphens trimmed after truncation.
export function branchSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

// Returns the autopilot branch name for a roadmap item.
// Format: auto/item-N-<slug>  (falls back to auto/item-N for all-special titles)
export function laneFor(item) {
  const slug = branchSlug(item.title);
  return slug ? `auto/item-${item.id}-${slug}` : `auto/item-${item.id}`;
}

// Sanitises an arbitrary string into a safe lock-filename fragment: lowercase,
// non-alphanumeric runs collapsed to single hyphens, trimmed of leading/
// trailing hyphens. Unlike branchSlug there's no length cap — lock names
// aren't git refs.
const fileSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Returns the per-lane autopilot lockfile name (a bare filename, joined onto
// ~/.stack by the caller). Lives beside laneFor for the same reason: the
// runner and the dispatcher must derive the same filename from the same job,
// and a name spelled out in two files drifts the first time either changes.
//
// A run pinned to one roadmap item locks that item; anything else (an
// unpinned night, a plan sweep, a debug/audit session) locks the project +
// kind instead, so unpinned nights on the same project still serialise
// against each other while pinned items run in parallel lanes.
export function lockFor({ slug, itemId, kind } = {}) {
  const safeSlug = fileSlug(slug) || 'unknown';
  const id = Number(itemId);
  if (Number.isInteger(id) && id > 0) return `autopilot-${safeSlug}-item-${id}.lock`;
  const safeKind = fileSlug(kind) || 'build';
  return `autopilot-${safeSlug}-${safeKind}.lock`;
}
