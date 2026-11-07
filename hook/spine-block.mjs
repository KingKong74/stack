// THE SPINE'S LINES in the SessionStart block (#616): where this project is
// going, before any card. Pure and zero-dependency, so it is testable
// (scripts/spine-block.test.mjs) without running the hook, which acts on
// import. stack-session-start.mjs loads it with a guarded dynamic import: a
// copy of the hook in ~/.stack without this file beside it loses the section,
// never the session.
//
// EVERY CAP IS STATED (root CLAUDE.md: "a capped prompt states its own cap").
// A session told a charter's first 600 characters as if they were the charter
// answers confidently about the rest.
//
// It reads only the project payload: `charter` (the server's capped opening,
// shape.js charterSummary), `milestones`, `slices` and `roadmap`. A slice's
// progress is DERIVED here exactly as lib/plan.ts sliceStateOf does it, on
// the Built predicate (root CLAUDE.md's mirrored-rules table).

// The payload's five priority keys (#469). Spelled here because a hook
// imports nothing from the server.
export const BUCKETS = ['highest', 'high', 'medium', 'low', 'lowest'];
export const GOAL_CAP = 300;
export const SPEC_CAP = 400;
export const SLICES_SHOWN = 8;

// BUILT: done, or a built note AND a claim. Both halves are load-bearing.
const isBuilt = (it) => !!it.done
  || (String(it.builtNote || '').trim() !== '' && String(it.claimedBy || '').trim() !== '');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const capped = (s, cap) => {
  const t = oneLine(s);
  return t.length > cap ? { text: t.slice(0, cap), cut: true } : { text: t, cut: false };
};

/**
 * The spine section as markdown lines, or [] when the project has none of it.
 * `branch` is the session's git branch: the slice of the open item claimed by
 * it is "your slice", with its spec.
 */
export function spineLines(p, branch) {
  const out = [];
  if (p?.charter?.summary) {
    const note = p.charter.truncated
      ? ` (its first ${p.charter.cap} characters; the whole charter is on Stack → Charter)`
      : '';
    out.push(`**Charter${note}:** ${oneLine(p.charter.summary)}`);
  }

  const rows = BUCKETS.flatMap((b) => (Array.isArray(p?.roadmap?.[b]) ? p.roadmap[b] : []))
    .filter((r) => r && !r.archived);
  const slices = Array.isArray(p?.slices) ? p.slices.filter((s) => !s.archived) : [];
  const ms = (Array.isArray(p?.milestones) ? p.milestones : []).find((m) => m.status === 'active');

  if (ms) {
    const firstGoal = String(ms.goal || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    const g = capped(firstGoal, GOAL_CAP);
    out.push(
      `**Current milestone:** ${ms.name}${ms.targetOn ? ` (target ${ms.targetOn})` : ''}`
      + `${g.text ? `: ${g.text}${g.cut ? ` (goal cut at ${GOAL_CAP} characters)` : ''}` : ''}`,
    );
    const mine = slices.filter((s) => s.milestoneId === ms.id);
    if (mine.length) {
      const list = mine.slice(0, SLICES_SHOWN).map((s) => {
        const its = rows.filter((r) => r.sliceId === s.id);
        return `- ${s.title}: ${its.filter(isBuilt).length}/${its.length} built`;
      });
      const more = mine.length > SLICES_SHOWN ? [`- …and ${mine.length - SLICES_SHOWN} more (Stack board)`] : [];
      out.push('', '**Slices in this milestone**', ...list, ...more);
    }
  }

  // YOUR SLICE: the slice of an open item this branch has claimed. Only a
  // real branch: `HEAD` (detached) and `main` claim nothing worth naming.
  if (branch && branch !== 'HEAD') {
    const claimed = rows.find((r) => !r.done && r.sliceId != null && String(r.claimedBy || '') === branch);
    const slice = claimed ? slices.find((s) => s.id === claimed.sliceId) : null;
    if (slice) {
      const spec = capped(slice.spec, SPEC_CAP);
      // The id is printed so /checkpoint can name it (`session.slice`, #626).
      out.push('', `**Your slice** (slice ${slice.id}; branch \`${branch}\` holds #${claimed.id}): ${slice.title}`);
      if (spec.text) out.push(`${spec.text}${spec.cut ? ` (spec cut at ${SPEC_CAP} characters; the whole spec is on the slice)` : ''}`);
    }
  }
  return out;
}
