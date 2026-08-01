// Autopilot lane naming helpers — shared by stack-autopilot.mjs and lane.test.mjs.
// This module is the ONE place any autopilot branch is named: every caller that
// used to build a branch string inline (bug runs, audit runs) now goes through
// here, so a git-validity fix only ever needs making once.

// Converts a title to a git-safe slug: lowercase, alphanumeric runs joined by
// hyphens, trailing hyphens trimmed after truncation.
// The output is provably always [a-z0-9-], never starts or ends with a hyphen,
// never contains '..' and is empty rather than a bare '-'/'@' — because every
// character outside [a-z0-9] (that includes '.', '@' and '-' itself) is folded
// into a single '-' separator BEFORE the leading/trailing trim runs, so a run of
// only-special input (a title like '-- fixed' or a bare '@') always collapses to
// nothing rather than surviving as a lone or leading hyphen. A leading hyphen is
// hazardous for more than git's ref rules: it makes the branch look like a CLI
// flag to git itself.
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

// Returns the autopilot branch name for a #228 bug-fix DEBUG run.
// Format: auto/<key-slug>-<title-slug>  (falls back to auto/<key-slug>, or
// auto/bug when the key itself sanitises to nothing). bug.id IS the key (e.g.
// 'BUG-12') and is pushed through the same sanitising as the title — an odd
// key must never be able to produce an invalid ref.
export function laneForBug(bug) {
  const key = branchSlug(String(bug.id)) || 'bug';
  const slug = branchSlug(bug.title);
  return slug ? `auto/${key}-${slug}` : `auto/${key}`;
}

// Returns the autopilot branch name for a #228 AUDIT hardening run.
// Format: auto/audit-<day>  (auto/audit-<day>-<scope-slug> when a scope is
// given). day is a compact date string (e.g. '20260802') sanitised the same
// way as everything else here — cheap insurance if the caller's date format
// ever changes. A scope that slugs to nothing behaves as no scope at all.
export function laneForAudit(day, scope) {
  const daySlug = branchSlug(day);
  const scopeSlug = branchSlug(scope);
  return scopeSlug ? `auto/audit-${daySlug}-${scopeSlug}` : `auto/audit-${daySlug}`;
}

// Resolves a collision on a proposed branch name WITHOUT ever deleting an
// existing branch to make room. `isTaken` is a pure predicate the caller
// supplies (the runner backs it with a check against git refs); this function
// makes no git calls and does no I/O. The old behaviour force-deleted whatever
// branch already held the name, which is exactly wrong when that branch may
// hold another run's pushed, unmerged work — a run must never destroy an
// earlier run's branch just because they picked the same name. Instead this
// tries `name`, then `name-2`, `name-3`, … up to `name-<max>`, and throws
// rather than silently colliding or looping forever.
export function freeBranchName(name, isTaken, max = 20) {
  if (!isTaken(name)) return name;
  for (let n = 2; n <= max; n++) {
    const candidate = `${name}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`freeBranchName: no free name for "${name}" after ${max} suffixes`);
}
