// A PLAN-MODE PLAN, CUT INTO UNITS — what Plans → Session plans offers to turn
// into roadmap items (Split) or into one item's steps (Attach). Pure, so
// scripts/plan-units.test.mjs runs it under Node.
//
// A UNIT IS A SECTION: the shallowest heading level below the title that
// appears at least twice, with everything under it up to the next heading of
// that level or shallower. Claude's plans are written that way ("## Unit 1 —
// …", "## Step 2: …"); a plan with no such level offers its top-level numbered
// list instead, and one with neither offers nothing, which is an honest answer.
//
// THIS ONLY PROPOSES. Every unit is shown to a human with a tick and an
// editable title before anything is written. `meta` marks the sections that
// describe the plan rather than being work (Context, Verification, Commits …);
// they start unticked, never hidden, because a heuristic is allowed to be
// wrong only in the direction a human can see and undo.
//
// Headings inside fenced code are not headings: a plan's shell block full of
// `# Unit 0 — the gateway` comments must not become seven phantom units.

export interface PlanUnit {
  title: string;   // the heading, with a "Unit 3 —" / "Step 2:" prefix taken off
  body: string;    // the section's markdown, heading excluded, trimmed
  meta: boolean;   // describes the plan rather than being work: starts unticked
}

const META = /^(context|background|overview|summary|goals?|verification|verify|testing plan|commits?|open questions?|questions|risks?|notes?|out of scope|non-goals|references|appendix|rollback|alternatives( considered)?|decisions?)\b/i;
const PREFIX = /^(?:(?:unit|step|phase|part|stage|task)\s*\d+[a-z]?|\d+[.)])\s*(?:[—–:.-]\s*)?/i;

export function unitTitle(heading: string): string {
  const clean = heading.replace(/[*_`]/g, '').replace(/\s+#+\s*$/, '').trim();
  return clean.replace(PREFIX, '').trim() || clean;
}

export function planUnits(src: string): PlanUnit[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const heads: { at: number; level: number; text: string }[] = [];
  let fence = '';
  lines.forEach((line, at) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence ? (line.trim().startsWith(fence) ? '' : fence) : f[1]; return; }
    if (fence) return;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) heads.push({ at, level: h[1].length, text: h[2] });
  });

  // The title is the first heading when it is the only one at its level.
  const top = heads[0]?.level ?? 0;
  const titleOnly = heads.length > 0 && heads.filter((h) => h.level === top).length === 1;
  const levels = [...new Set(heads.map((h) => h.level))].sort((a, b) => a - b)
    .filter((l) => !(titleOnly && l === top));
  const level = levels.find((l) => heads.filter((h) => h.level === l).length >= 2);

  if (level !== undefined) {
    return heads.filter((h) => h.level === level).map((h) => {
      const next = heads.find((n) => n.at > h.at && n.level <= level);
      const body = lines.slice(h.at + 1, next ? next.at : lines.length).join('\n').trim();
      const title = unitTitle(h.text);
      return { title, body, meta: META.test(title) };
    }).filter((u) => u.title);
  }

  // No section level: the top-level numbered list, outside fences.
  const out: PlanUnit[] = [];
  fence = '';
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence ? (line.trim().startsWith(fence) ? '' : fence) : f[1]; continue; }
    if (fence) continue;
    const m = line.match(/^\d+[.)]\s+(.*)$/);
    if (m) {
      const title = unitTitle(m[1]).replace(/\s*[:—–-]\s*$/, '');
      out.push({ title, body: '', meta: META.test(title) });
    }
  }
  return out.length >= 2 ? out : [];
}
