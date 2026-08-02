// ONE definition of what a night's "debrief" is (#286/#24a). The Review room's
// nights list and Mission Control's NightDebrief panel had each grown their own
// copy of this arithmetic — landed/failed/planned counts, the reviewer/architect
// rollup, where the two disagree, what the night is still waiting on — and the
// copies were already drifting on the two rules that are easy to get wrong by
// guessing:
//
//   - A PLAN night is the advisor working, not the advisor idle (CLAUDE.md).
//     `outcome:'planned'` is counted on its own axis and is NEVER landed and
//     NEVER failed — folding it into either scores a night that did exactly
//     what it was asked to do as having produced nothing, or as broken.
//   - An empty second-model read means NO PASS RAN, not "nothing found". A
//     night with zero reviewed runs must come back `{ran: 0, clean: 0, ...}`,
//     never something a caller could mistake for a clean sweep. Same for the
//     architect.
//
// The five outcomes (schema.sql: landed | no-commits | failed | limit |
// planned) are partitioned across FOUR stats buckets — landed, failed
// (failed + limit), planned, noCommits — so those four always sum to
// `stats.runs`. `noCommits` gets its own bucket rather than folding into
// `failed`: a run that legitimately found nothing to do is not a failure,
// and letting it fall through every bucket is the same absence-reads-as-
// good-news mistake as an unrun reviewer — a night that ran and produced
// nothing must not disappear from the count.
//
// Pure and DB-free by design (no import from db.js, no I/O) so it can be
// pinned without a server:
//   node server/test/debrief.test.mjs
//
// Callers pass it the ALREADY-SHAPED run rows (routes/review.js's `nights`,
// built from shape.js's runCore()/agentReads()) plus the per-push Gemini
// notes — this module only does the arithmetic, never the shaping.

// BIGINT/NUMERIC arrive from pg as STRINGS; a run passed in from anywhere
// other than review.js's already-coerced shape must not be trusted to be a
// number. Never let a bad value turn a sum into NaN or a concatenated string.
const num = (x) => Number(x) || 0;

// reviewFindings is an INT count (schema.sql), but guard the same way for a
// caller that hands through something array-shaped — either way, absent
// counts as zero, never as NaN.
const findingsOf = (r) => (Array.isArray(r.reviewFindings) ? r.reviewFindings.length : num(r.reviewFindings));

// A short, stable reference to the run's own item or, failing that, its
// branch — every decision sentence names WHAT it is about.
const refOf = (r) => (r.itemId ? `#${r.itemId} ${r.itemTitle || 'item'}` : r.branch || 'this run');

// A push note attaches to the run it was written about, and ONLY by branch
// (plus slug, when both sides carry one) — never by array position, since the
// two lists are not parallel. The LAST matching note wins, matching how the
// notes list itself is ordered (newest appended last).
function pushNoteFor(run, notes) {
  let found = '';
  for (const n of notes) {
    if (!run.branch || n.branch !== run.branch) continue;
    if (n.slug && run.slug && n.slug !== run.slug) continue;
    found = n.note || '';
  }
  return found;
}

// One line, at most, per run — in this precedence, first match wins. A run
// can be blocked AND red AND paused; only the most actionable of those is
// worth a row, or the debrief reads as louder than the decision actually is.
const DECISION_KINDS = [
  {
    kind: 'blocked',
    tag: 'BLOCKED',
    test: (r) => r.reviewVerdict === 'blocked',
    sentence: (r) => `${refOf(r)} was blocked by the reviewer — it needs a look before it goes any further.`,
  },
  {
    kind: 'checks',
    tag: 'CHECKS',
    test: (r) => num(r.checksFailing) > 0,
    sentence: (r) => {
      const n = num(r.checksFailing);
      return `${refOf(r)} left ${n} check${n === 1 ? '' : 's'} red — worth closing before the next night.`;
    },
  },
  {
    kind: 'paused',
    tag: 'PAUSED',
    test: (r) => r.outcome === 'limit',
    sentence: (r) => `${refOf(r)} stopped on the usage limit and is waiting to resume.`,
  },
  {
    kind: 'failed',
    tag: 'FAILED',
    test: (r) => r.outcome === 'failed',
    sentence: (r) => `${refOf(r)} failed outright and needs a look.`,
  },
];

export function composeDebrief({ day, slug = null, runs = [], notes = [] }) {
  const list = Array.isArray(runs) ? runs : [];
  const noteList = Array.isArray(notes) ? notes : [];

  const landedRuns = list.filter((r) => r.outcome === 'landed');
  const plannedRuns = list.filter((r) => r.outcome === 'planned');
  // "failed" reads the real outcome vocabulary (schema.sql): landed |
  // no-commits | failed | limit | planned. `limit` is a stop, not a plan, and
  // it is NOT a landed run either — it counts alongside 'failed' here, and
  // gets its own, gentler 'paused' decision below rather than a 'failed' tag.
  const failedRuns = list.filter((r) => r.outcome === 'failed' || r.outcome === 'limit');
  const noCommitsRuns = list.filter((r) => r.outcome === 'no-commits');

  const tokens = list.reduce((n, r) => n + num(r.tokens), 0);
  const costUsd = list.reduce((n, r) => n + num(r.costUsd), 0);
  const landed = landedRuns.length;
  const projects = new Set(list.map((r) => r.slug).filter(Boolean)).size;

  const reviewedRuns = list.filter((r) => r.reviewVerdict);
  const archedRuns = list.filter((r) => r.architectVerdict);
  const aligned = archedRuns.filter((r) => r.architectVerdict === 'aligned').length;

  // Both verdicts present AND pointed the opposite way on the SAME run — the
  // only honest basis for "where they disagree".
  const disagree = list
    .filter((r) => r.reviewVerdict && r.architectVerdict
      && ((r.reviewVerdict !== 'clean' && r.architectVerdict === 'aligned')
        || (r.reviewVerdict === 'clean' && r.architectVerdict !== 'aligned')))
    .map((r) => ({
      slug: r.slug ?? null,
      itemId: r.itemId ?? null,
      itemTitle: r.itemTitle || '',
      branch: r.branch || '',
      reviewVerdict: r.reviewVerdict,
      architectVerdict: r.architectVerdict,
    }));

  // At most one decision per run — the FIRST kind (in DECISION_KINDS order)
  // it qualifies for, so a run that is both blocked and red yields BLOCKED
  // alone rather than two rows arguing for the same attention. One pass over
  // the runs, bucketed by kind, so the output stays kind-precedence-then-
  // input-order without re-scanning DECISION_KINDS per run.
  const buckets = new Map(DECISION_KINDS.map((d) => [d.kind, []]));
  for (const r of list) {
    const def = DECISION_KINDS.find((d) => d.test(r));
    if (!def) continue;
    buckets.get(def.kind).push({
      kind: def.kind,
      tag: def.tag,
      slug: r.slug ?? null,
      itemId: r.itemId ?? null,
      itemTitle: r.itemTitle || '',
      branch: r.branch || '',
      sentence: def.sentence(r),
    });
  }
  const decisionsOnce = DECISION_KINDS.flatMap((d) => buckets.get(d.kind));

  return {
    day,
    scope: slug || null,
    ran: list.length > 0,
    stats: {
      runs: list.length,
      landed,
      failed: failedRuns.length,
      planned: plannedRuns.length,
      noCommits: noCommitsRuns.length,
      projects,
      tokens,
      costUsd,
      costPerLanded: landed > 0 ? costUsd / landed : null,
    },
    runs: list.map((r) => ({ ...r, pushNote: pushNoteFor(r, noteList) })),
    reviewer: {
      ran: reviewedRuns.length,
      clean: reviewedRuns.filter((r) => r.reviewVerdict === 'clean').length,
      flagged: reviewedRuns.filter((r) => r.reviewVerdict === 'concerns').length,
      blocked: reviewedRuns.filter((r) => r.reviewVerdict === 'blocked').length,
      findings: reviewedRuns.reduce((n, r) => n + findingsOf(r), 0),
    },
    architect: {
      ran: archedRuns.length,
      aligned,
      drifted: archedRuns.length - aligned,
    },
    disagree,
    decisions: decisionsOnce,
  };
}
