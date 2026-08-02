// #297 — the pure resolver behind the "Open Roadmap" link. When an app is
// selected, the link is unambiguous: that app's roadmap. When All Apps is
// selected there is no single roadmap to point at, so it falls back to the
// device's last-viewed project (store.ts's `stack.lastProject`, set when a
// detail page finishes loading) and, failing that, a server-derived stand-in
// the caller supplies (the overview's resume slug). Nothing resolving is a
// real answer — `null` — not an error: the house rule is absent, never a
// dead link (same as an unreachable check or a NULL review_verdict).
//
// This resolver answers with the SLUG, not a URL — callers build the href
// with `hrefTo.detail(target, 'roadmap')`, which keeps one spelling of the
// roadmap URL without this file owning one. A caller that also needs the
// destination's own NAME (for a title) resolves the slug once here and looks
// the project up by it, rather than re-deriving it from a built href.
//
// `known` exists because a candidate can go stale: a project viewed last week
// may since have been binned or renamed, and `stack.lastProject` would then
// point the link at a 404. When the caller knows the live slug set, any
// candidate not in it is skipped and the next one in the chain is tried.
// When `known` is undefined or empty, the caller simply doesn't know yet, so
// no filtering happens — filtering an empty list would just mean nothing to
// filter.
export function roadmapTarget(opts: {
  selected?: string;
  lastViewed?: string;
  fallback?: string;
  known?: string[];
}): string | null {
  const { selected, lastViewed, fallback, known } = opts;
  const filter = known && known.length > 0 ? known : null;
  const isLive = (slug: string) => !filter || filter.includes(slug);

  for (const candidate of [selected, lastViewed, fallback]) {
    if (candidate && isLive(candidate)) return candidate;
  }
  return null;
}
