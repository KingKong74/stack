import type { RoadmapItem, Roadmap as RoadmapData } from '../types';
import { dateAt, fmtDate, slipOf, MIN_PER_WEEK } from '../lib/plan';
import { isBuilt } from '../lib/spine';

// THE PLANS TAB — the kit's PlansScreen list, and the surface the schedule
// columns have been waiting for.
//
// `sched_start_min` / `sched_len_min` and their write-once baseline have been
// stored, served and baselined on create since #401, and since the Timeline was
// culled in #428 NOTHING IN THE CLIENT HAS READ THEM. CLAUDE.md says to leave
// them alone because they are data waiting for a surface; this is that surface.
// It is a READER, not an editor: the Timeline was their only editor and it is
// not coming back in this commit, so nothing here writes a minute.
//
// THREE THINGS IT REFUSES TO FAKE, all the same rule — absence is not a value:
//
//  • UNSCHEDULED IS A STATE. `sched === null` is a real answer (#401: "never
//    minute 0"), so its dates are dashes, not today.
//  • NO WEEK ZERO MEANS NO DATES. A minute offset is only a date once the
//    project has an origin to count from, so without one the column says which
//    WEEK the offset lands in and does not invent a calendar.
//  • PROGRESS IS ONLY REAL IF SOMETHING COUNTED IT. An item with no plan steps
//    has no measured progress, and a 0% bar reads as "nothing done" when it
//    means "nothing recorded" — so it draws a dash. Same rule as a NULL
//    review_verdict.
//
// SLIP IS AGAINST THE BASELINE AND ONLY EXISTS IF THERE IS ONE (lib/plan.ts).
// `baseline === null` is not "on plan", so it gets no marker at all rather than
// a clean one.

type Row = { it: RoadmapItem; n: number };

const STATUS = {
  done: { label: 'Done', tone: 'success' },
  review: { label: 'In review', tone: 'info' },
  progress: { label: 'In progress', tone: 'info' },
  parked: { label: 'Parked', tone: 'warning' },
  todo: { label: 'To do', tone: 'neutral' },
} as const;

function statusOf(it: RoadmapItem): keyof typeof STATUS {
  if (it.done) return 'done';
  // BUILT-or-ticked, the #374 predicate: a built item awaiting a verdict is not
  // "to do", and a path that reads `done` alone draws an empty plan over a full
  // night's work.
  if (isBuilt(it)) return 'review';
  if (it.claimedBy) return 'progress';
  if (it.skipped) return 'parked';
  return 'todo';
}

/** null = nothing counted it. Never 0 — see the header. */
function progressOf(it: RoadmapItem): number | null {
  if (it.done) return 100;
  if (it.plan && it.plan.length) {
    return Math.round((it.plan.filter((s) => s.done).length / it.plan.length) * 100);
  }
  return null;
}

function when(min: number | null, weekZero: string | null): string {
  if (min == null) return '—';
  const d = dateAt(min, weekZero);
  return d ? fmtDate(d) : `wk ${Math.floor(min / MIN_PER_WEEK) + 1}`;
}

export function Plans({ roadmap, weekZero, onOpen }: {
  roadmap: RoadmapData;
  weekZero: string | null;
  onOpen: (it: RoadmapItem) => void;
}) {
  const all = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont]
    .filter((i) => !i.archived);

  // GROUPED BY AREA, because an area is a real thing here and not a label: it
  // is half of the lane key that decides what may run beside what (#267). The
  // untagged group is named as untagged rather than folded into another — an
  // untagged area is never a lane, and pretending otherwise is how a whole
  // night's work collapses into one.
  const areas = [...new Set(all.map((i) => i.area || ''))].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  let n = 0;
  const groups = areas.map((area) => {
    const items = all
      .filter((i) => (i.area || '') === area)
      .sort((a, b) => {
        const sa = a.sched ? a.sched.start : Infinity;
        const sb = b.sched ? b.sched.start : Infinity;
        if (sa !== sb) return sa - sb;
        return String(a.title).localeCompare(String(b.title));
      });
    const rows: Row[] = items.map((it) => ({ it, n: ++n }));
    const done = items.filter((i) => i.done).length;
    return { area, rows, done, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
  });

  const scheduled = all.filter((i) => i.sched).length;

  return (
    <div className="plans">
      <div className="plans-head">
        <div className="plans-lede">
          Every item on this project against the schedule it was given. Read-only: the drag editor
          went with the Timeline, so these are the stored bars, not a plan you can move here.
        </div>
        <span className="plans-count">
          {all.length} items · {scheduled} scheduled
          {weekZero ? ` · week zero ${weekZero}` : ' · no week zero, so offsets are weeks not dates'}
        </span>
      </div>

      <div className="plans-scroll">
        <div className="plans-grid">
          <div className="pg-head">
            <span className="c-n">#</span>
            <span className="c-item">Work item</span>
            <span className="c-status">Status</span>
            <span className="c-branch">Branch</span>
            <span className="c-date">Start</span>
            <span className="c-date">Due</span>
            <span className="c-pri">Priority</span>
            <span className="c-prog">Progress</span>
            <span className="c-verdict">Verdict</span>
          </div>

          {groups.map((g) => (
            <div className="pg-group" key={g.area || '(untagged)'}>
              <div className="pg-grouphead">
                <span className="nm">{g.area || 'Untagged'}</span>
                <span className="sub">{g.rows.length} item{g.rows.length === 1 ? '' : 's'}</span>
                <Meter value={g.rows.length ? g.pct : null} />
              </div>

              {g.rows.map(({ it, n: idx }) => {
                const st = STATUS[statusOf(it)];
                const slip = slipOf(it);
                const prog = progressOf(it);
                return (
                  <div className="pg-row" key={it.id} onClick={() => onOpen(it)}>
                    <span className="c-n">{idx}</span>
                    <span className="c-item">
                      <span className="id">#{it.id}</span>
                      <span className="t">{it.title}</span>
                    </span>
                    <span className="c-status"><span className={`pg-tag ${st.tone}`}>{st.label}</span></span>
                    <span className="c-branch">
                      {it.claimedBy
                        ? <span className="br" title={it.claimedBy}>{it.claimedBy}</span>
                        : <span className="dash">—</span>}
                    </span>
                    <span className="c-date">{when(it.sched ? it.sched.start : null, weekZero)}</span>
                    <span className="c-date">
                      {when(it.sched ? it.sched.start + it.sched.len : null, weekZero)}
                    </span>
                    <span className="c-pri">
                      {it.tier
                        ? <span className={`tierchip t${it.tier}`}>{it.tier}</span>
                        : <span className="dash">—</span>}
                      <span className="bucket">{it.bucket}</span>
                    </span>
                    <span className="c-prog"><Meter value={prog} /></span>
                    <span className="c-verdict">
                      {it.reviewTag
                        ? <span className={`pg-tag ${it.reviewTag === 'solid' ? 'success' : 'warning'}`}>{it.reviewTag}</span>
                        : isBuilt(it) && !it.done
                          ? <span className="pg-tag info">awaiting you</span>
                          : <span className="dash">—</span>}
                      {slip.measured && slip.min != null && slip.min !== 0 && (
                        <span className="slip" title={`Moved ${Math.abs(Math.round(slip.min / MIN_PER_WEEK * 10) / 10)} weeks ${slip.min > 0 ? 'later than' : 'earlier than'} the baseline it was given`}>
                          {slip.min > 0 ? '▲' : '▼'}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          {all.length === 0 && (
            <div className="pg-empty">Nothing on the roadmap yet, so there is no plan to draw.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** null draws a dash: nothing counted it, which is not 0%. */
function Meter({ value }: { value: number | null }) {
  if (value == null) return <span className="dash" title="No plan steps on this item, so nothing has measured its progress">—</span>;
  return (
    <span className="pg-meter">
      <span className="track"><span className={`fill${value === 100 ? ' full' : ''}`} style={{ width: `${value}%` }} /></span>
      <span className="pct">{value}%</span>
    </span>
  );
}
