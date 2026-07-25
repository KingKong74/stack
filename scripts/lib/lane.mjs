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
