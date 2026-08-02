import { useMemo, useState } from 'react';
import type { ControlData, ControlProject, AutopilotJob, Preview, MergeAutonomy } from '../store';
import { go } from '../lib/route';
import {
  LANE_KINDS, KIND_HINT, KIND_TONE, MERGE_STATES, MERGE_STATE_META,
  parseBranch, mergeStateOf, isMergeable,
  type LaneKind, type MergeState,
} from '../lib/branch';

// ---------------------------------------------------------------------------
// #363 (design 1a) — the MERGE room: every open branch in the house, in one
// ledger, and the agent that orders them into waves.
//
// The branch strip on the Now room answers "what is open on THIS project". It
// is a chip list inside a project card, which is exactly right for a card and
// exactly wrong for the question this room asks: with five projects and forty
// branches, what merges next, and what is in the way. A chip cannot carry a
// size, a state and an area at once, and a per-card strip cannot say that two
// branches in different projects are both rewriting the same shared file.
//
// Three things make this a room rather than a bigger strip:
//
//   • It is WEIGHTED. The host's report now carries the diff (#363 extends
//     #207), so a branch reads as its size — a one-commit branch can be a
//     2,000-line rewrite, and ahead/behind never said so.
//   • It is TYPED. Lanes are `<kind>/<id>-<slug>` now, so "show me the fixes"
//     is a filter rather than a read-every-title exercise.
//   • It PLANS. The merge agent orders the mergeable branches into waves in
//     which no two touch the same area, which is the only ordering that makes
//     a run of merges less likely to break main than the same merges in a
//     random order.
//
// What it deliberately does NOT have is the design's staging branch. 1a lands
// everything on `staging` first and promotes to main behind a soak gate;
// Stack's merge job merges into main, and drawing a staging card over a
// pipeline that has none would be a picture of a safety net that isn't there.
// The room says main is the target, in the header, where the press is.
// ---------------------------------------------------------------------------

const OPEN_JOB = new Set<AutopilotJob['status']>(['queued', 'claimed', 'running']);

const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// A branch flattened for the ledger: its project, its parsed name, its state
// and its diff. Everything here is read off the payload — nothing is inferred
// beyond `state`, whose derivation lives in lib/branch.ts.
interface Row {
  key: string;
  project: ControlProject;
  branch: ControlProject['branches'][number];
  kind: LaneKind | '';
  state: MergeState;
  itemId: string;
  itemTitle: string;
  label: string;          // what the row prints after the kind prefix
  adds: number; dels: number; files: number;
  sized: boolean;         // the report carried a diff at all
  area: string;
  at: number;             // committedAt as epoch ms; 0 = unknown
  job: AutopilotJob | null;
}

// The area a wave planner treats a branch as occupying. An unknown area is its
// OWN bucket, not a free pass: if we cannot see what a branch touches we
// cannot claim it is disjoint from anything, so at most one unsized branch
// goes into any wave.
const areaKey = (r: Row) => (r.area ? `a:${r.area}` : `?:${r.key}`);

// Greedy area-disjoint waves: walk the ordered pool, take every branch whose
// area is not already spoken for in this wave, repeat with what is left.
//
// This is the agent's whole cleverness and it is deliberately small. It cannot
// know that two branches interact semantically; what it CAN do is stop two
// branches that rewrite the same directory from being merged back to back
// without anything running in between, which is the failure the host's
// per-branch probe cannot see (each one merges cleanly against main; they do
// not merge cleanly against each other).
function planWaves(pool: Row[], order: 'area' | 'age' | 'size'): Row[][] {
  const left = [...pool];
  if (order === 'age') left.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
  else if (order === 'size') left.sort((a, b) => (a.adds + a.dels) - (b.adds + b.dels));
  else left.sort((a, b) => (a.area || '~').localeCompare(b.area || '~') || a.key.localeCompare(b.key));
  const out: Row[][] = [];
  // The bound guards a pathological pool, it is not a policy: every iteration
  // removes at least one branch, so this cannot spin.
  while (left.length && out.length < 12) {
    const taken = new Set<string>();
    const wave: Row[] = [];
    for (let i = 0; i < left.length;) {
      const k = areaKey(left[i]);
      if (!taken.has(k)) { taken.add(k); wave.push(left.splice(i, 1)[0]); } else i++;
    }
    out.push(wave);
  }
  return out;
}

export function MergeRoom({
  data, previews, previewBusy,
  onMerge, onStartPreview, onStopPreview, onSetAutonomy, onQueueMerge,
}: {
  data: ControlData;
  previews: Preview[];
  previewBusy: string | null;
  onMerge: (p: ControlProject, b: ControlProject['branches'][number]) => void;
  onStartPreview: (slug: string, branch: string, itemId: string | null) => void;
  onStopPreview: (pv: Preview) => void;
  onSetAutonomy: (p: ControlProject, v: MergeAutonomy) => void;
  onQueueMerge: (slug: string, branch: string, itemId: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState<MergeState | 'all'>('all');
  const [projFilter, setProjFilter] = useState('');       // '' = the whole house
  const [kindFilter, setKindFilter] = useState<LaneKind | ''>('');
  const [sel, setSel] = useState<Record<string, true>>({});
  const [open, setOpen] = useState('');                    // the expanded row's key
  const [order, setOrder] = useState<'area' | 'age' | 'size'>('area');
  // Every BULK path ends here rather than merging on the press. One branch
  // still goes through the per-row confirm (the same dialog the Now room
  // opens); a press that would queue several merges into main and delete
  // several remote branches gets a list of exactly what it will do first.
  // `hold` is what is in the plan for ordering but will not be queued.
  const [run, setRun] = useState<{ what: string; rows: Row[]; hold: Row[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState<Record<string, string>>({}); // key → '' ok | reason
  const [err, setErr] = useState('');

  // ---- the ledger -------------------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of data.projects) {
      for (const b of p.branches) {
        const parsed = parseBranch(b.branch);
        const job = data.jobs.find((j) =>
          j.slug === p.slug && j.kind === 'merge' && j.detail.includes(`origin/${b.branch} into`)) ?? null;
        out.push({
          key: `${p.slug}/${b.branch}`,
          project: p, branch: b,
          kind: parsed.kind,
          state: mergeStateOf(b),
          itemId: b.itemId || (parsed.itemId != null ? String(parsed.itemId) : ''),
          itemTitle: b.itemTitle || '',
          label: parsed.bugKey
            ? `${parsed.bugKey.toLowerCase()}${parsed.summary ? `-${parsed.summary}` : ''}`
            : parsed.itemId != null
              ? `${parsed.itemId}${parsed.summary ? `-${parsed.summary}` : ''}`
              : parsed.summary || b.branch,
          adds: b.adds ?? 0, dels: b.dels ?? 0, files: b.files ?? 0,
          sized: (b.files ?? 0) > 0,
          area: b.area || '',
          at: b.committedAt ? Date.parse(b.committedAt) || 0 : 0,
          job,
        });
      }
    }
    return out;
  }, [data]);

  // A branch with a merge job already in flight is out of everything below:
  // it is neither pickable nor plannable, because it is already going.
  const live = (r: Row) => !!r.job && OPEN_JOB.has(r.job.status);
  const merged = (r: Row) => !!r.job && r.job.status === 'done';

  const stateCounts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const s of MERGE_STATES) c[s] = 0;
    for (const r of rows) c[r.state]++;
    return c;
  }, [rows]);

  const kindCounts = useMemo(() => {
    const c = new Map<LaneKind, number>();
    for (const r of rows) if (r.kind) c.set(r.kind, (c.get(r.kind) ?? 0) + 1);
    return c;
  }, [rows]);

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) =>
    (stateFilter === 'all' || r.state === stateFilter)
    && (!projFilter || r.project.slug === projFilter)
    && (!kindFilter || r.kind === kindFilter)
    && (!needle
      || r.branch.branch.toLowerCase().includes(needle)
      || r.itemTitle.toLowerCase().includes(needle)
      || r.area.toLowerCase().includes(needle)));

  // ---- the agent's plan -------------------------------------------------
  // Only MERGEABLE branches enter it, and only from projects whose autonomy is
  // not 'off'. Greedy area-disjoint waves: walk the ordered pool, take every
  // branch whose area is not already spoken for in this wave, repeat.
  const autonomyOf = (p: ControlProject): MergeAutonomy => p.mergeAutonomy ?? 'plan';
  const plannable = rows
    .filter((r) => isMergeable(r.state) && !live(r) && !merged(r) && autonomyOf(r.project) !== 'off');

  const waves = planWaves(plannable, order);
  const flatPlan = waves.flat();
  // What ▶ Run actually presses. 'plan' projects are IN the plan — the ordering
  // is not honest if it pretends their branches are not there — but the press
  // leaves them alone, which is the whole difference between the two settings.
  const agentRows = flatPlan.filter((r) => autonomyOf(r.project) === 'auto');
  const agentHold = flatPlan.filter((r) => autonomyOf(r.project) !== 'auto');

  const selRows = visible.filter((r) => sel[r.key] && !live(r) && !merged(r));

  // ---- actions ----------------------------------------------------------
  const toggle = (k: string) => setSel((s) => {
    const next = { ...s };
    if (next[k]) delete next[k]; else next[k] = true;
    return next;
  });

  // Opens on ANYTHING in the plan, held rows included. The first cut guarded on
  // `list.length` — the auto rows — and the default autonomy is 'plan', so on a
  // fresh house ▶ Run had nothing in `list` and returned silently: a headline
  // button that did nothing at all, with no way to find out why. Held rows are
  // a state the dialog has to be able to SHOW, not a reason not to open it.
  const openRun = (what: string, list: Row[], hold: Row[]) => {
    if (!list.length && !hold.length) return;
    setQueued({});
    setErr('');
    setRun({ what, rows: list, hold });
  };

  const queueAll = async (list: Row[]) => {
    if (running || !list.length) return;
    setRunning(true);
    setErr('');
    for (const r of list) {
      try {
        await onQueueMerge(r.project.slug, r.branch.branch, r.itemId);
        setQueued((s) => ({ ...s, [r.key]: '' }));
      } catch (e) {
        const reason = (e as Error)?.message || 'could not be queued';
        setQueued((s) => ({ ...s, [r.key]: reason }));
        // The dispatcher takes one job at a time and each merge lands on the
        // main the last one produced, so a failure part-way through means the
        // rest would be queued against a main that never arrived. Stop, and
        // say how far it got — the same rule the Now room's merge train
        // follows (#193).
        setErr(`Stopped at ${r.branch.branch} — ${reason}. The branches after it were not queued.`);
        break;
      }
    }
    setRunning(false);
  };

  const previewFor = (slug: string, branch: string) =>
    previews.find((v) => v.slug === slug && v.branch === branch
      && v.status !== 'stopped' && v.status !== 'failed') ?? null;

  // ---- grouped by project ----------------------------------------------
  const groups = data.projects
    .map((p) => ({ p, rows: visible.filter((r) => r.project.slug === p.slug) }))
    .filter((g) => g.rows.length);

  // The dispatcher reports every repo in one pass, so the ages agree; what it
  // cannot report is a project whose repo it cannot find on the host. Those
  // projects still contribute rows here (a claim with no branch behind it), and
  // a header reading "git as of 4m ago" over them would be claiming a freshness
  // for branches nothing has looked at. Say how many, rather than averaging the
  // reported ones into a number that covers them.
  const reportAge = data.projects.map((p) => p.branchesWhen).filter(Boolean)[0] || '';
  const unreported = data.projects.filter((p) => p.branches.length && !p.branchesWhen).length;
  const liveWorkers = data.fleet?.slots?.length ?? 0;

  return (
    <div className="mc-merge">
      {err && <div className="action-error">{err}</div>}

      {/* ---- header ---- */}
      <div className="mc14-room-head mc-merge-head">
        <span className="title">Merge</span>
        <span className="meta">{rows.length} open branch{rows.length === 1 ? '' : 'es'} · {data.projects.length} project{data.projects.length === 1 ? '' : 's'}</span>
        {liveWorkers > 0 && (
          <span className="mc-merge-live"
            title="Autopilot jobs in flight across the house right now — they are what is PRODUCING these branches, not what merges them (a merge job runs on the same dispatcher, one at a time).">
            <i />{liveWorkers} worker{liveWorkers === 1 ? '' : 's'} live
          </span>
        )}
        <span className="meta mc-merge-target"
          title="Merges from this room go straight to main, exactly as the ⇥ Merge button on the Now room does: the host merges origin/<branch> into main in a throwaway worktree, pushes, and deletes the remote branch. Conflicts abort safely. There is no staging branch between the two.">
          ⎇ target: main
        </span>
        <span className="meta"
          title="The host dispatcher fetches each repo and re-probes every ~10 minutes. Every state, size and area on this page is from that pass, not from this page load.">
          {reportAge ? `git as of ${reportAge}` : 'no git report from the host yet'}
        </span>
        {unreported > 0 && (
          <span className="meta mc-merge-warnmeta"
            title="The host has no git report for these projects — their rows come from roadmap claims alone, so they carry no state, no size and no area. Usually it means the repo is not checked out under the dispatcher's root.">
            {unreported} project{unreported === 1 ? '' : 's'} unreported
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="meta mc-merge-naming" title="The convention the runner cuts lanes by. Older auto/item-N branches are still read, and still merge.">
          naming: &lt;kind&gt;/&lt;id&gt;-&lt;summary&gt;
        </span>
        <input className="mc-merge-q" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="filter branches" aria-label="Filter branches" />
        <button className="btn-accent mc-merge-run" disabled={!flatPlan.length}
          title={!flatPlan.length
            ? 'Nothing mergeable to plan — every open branch conflicts, is unprobed, or sits in a project set to Off.'
            : agentRows.length
              ? `Open the plan — ${agentRows.length} branch${agentRows.length === 1 ? '' : 'es'} would be queued, and nothing is queued until you press again inside it.`
              : 'Open the plan — every project in it is set to Plan, so the dialog will ask before it queues anything.'}
          onClick={() => openRun('the merge agent’s plan', agentRows, agentHold)}>▶ Run merge agent</button>
      </div>

      {/* ---- filters ---- */}
      <div className="mc-merge-filters">
        <button className={`mc-merge-chip ${stateFilter === 'all' ? 'on' : ''}`}
          onClick={() => setStateFilter('all')}>
          All<span className="n">{stateCounts.all}</span>
        </button>
        {MERGE_STATES.map((s) => (
          <button key={s} className={`mc-merge-chip ${stateFilter === s ? 'on' : ''}`}
            title={MERGE_STATE_META[s].hint} onClick={() => setStateFilter(s)}>
            <i style={{ background: MERGE_STATE_META[s].tone }} />
            {MERGE_STATE_META[s].label}<span className="n">{stateCounts[s]}</span>
          </button>
        ))}
        <span className="mc-merge-sep" />
        <button className={`mc-merge-chip proj ${!projFilter ? 'on' : ''}`} onClick={() => setProjFilter('')}>
          All projects
        </button>
        {data.projects.filter((p) => p.branches.length).map((p) => (
          <button key={p.slug} className={`mc-merge-chip proj ${projFilter === p.slug ? 'on' : ''}`}
            onClick={() => setProjFilter(p.slug)}>
            <i className="sq" style={{ background: p.tint || 'var(--muted)' }} />{p.name}
          </button>
        ))}
        {kindCounts.size > 0 && <span className="mc-merge-sep" />}
        {LANE_KINDS.filter((k) => kindCounts.get(k)).map((k) => (
          <button key={k} className={`mc-merge-kind ${kindFilter === k ? 'on' : ''}`}
            style={kindFilter === k ? { borderColor: KIND_TONE[k], color: KIND_TONE[k] } : undefined}
            title={`${k} — ${KIND_HINT[k]}`}
            onClick={() => setKindFilter((v) => (v === k ? '' : k))}>
            {k}<span className="n">{kindCounts.get(k)}</span>
          </button>
        ))}
        {/* One box, not two loose buttons with a spacer between them: the bar
            WRAPS, and a spacer pushes the second button onto a line of its own
            at the left margin — the two halves of one action, separated. */}
        <div className="mc-merge-bulks">
          <button className="mc-merge-bulk"
            title="Tick every branch on screen the host’s probe says merges into main"
            onClick={() => setSel(Object.fromEntries(
              visible.filter((r) => isMergeable(r.state) && !live(r) && !merged(r)).map((r) => [r.key, true as const])))}>
            Select all mergeable
          </button>
          <button className={`mc-merge-bulk go ${selRows.length ? 'on' : ''}`} disabled={!selRows.length || running}
            title={selRows.length ? `Queue a merge job for each of the ${selRows.length} ticked branches, in the order shown` : 'Tick some branches first'}
            onClick={() => openRun(`${selRows.length} branch${selRows.length === 1 ? '' : 'es'} you ticked`, selRows, [])}>
            Merge selected → main · {selRows.length}
          </button>
        </div>
      </div>

      {/* ---- the ledger + the agent rail ---- */}
      <div className="mc-merge-cols">
        <div className="mc-merge-list">
          {groups.map(({ p, rows: grows }) => {
            const all = rows.filter((r) => r.project.slug === p.slug);
            const segs = MERGE_STATES
              .map((s) => ({ s, n: all.filter((r) => r.state === s).length }))
              .filter((x) => x.n > 0);
            const mergeableN = all.filter((r) => isMergeable(r.state) && !live(r) && !merged(r)).length;
            const add = all.reduce((a, r) => a + r.adds, 0);
            const del = all.reduce((a, r) => a + r.dels, 0);
            const anySized = all.some((r) => r.sized);
            return (
              <div key={p.slug} className="mc-merge-group">
                <div className="mc-merge-grouphead">
                  <i className="sq" style={{ background: p.tint || 'var(--muted)' }} />
                  <button className="nm" onClick={() => go.detail(p.slug, 'roadmap')}>{p.name}</button>
                  <span className="meta">{all.length} branch{all.length === 1 ? '' : 'es'} · {mergeableN} mergeable</span>
                  <span className="mc-merge-seg" aria-hidden>
                    {segs.map(({ s, n }) => (
                      <i key={s} style={{ width: `${(n / all.length) * 100}%`, background: MERGE_STATE_META[s].tone }} />
                    ))}
                  </span>
                  {anySized && <span className="meta diff">+{fmtN(add)} −{fmtN(del)}</span>}
                  {mergeableN > 0 && (
                    <button className="mc-merge-groupgo"
                      title={`Queue a merge for each of ${p.name}'s ${mergeableN} mergeable branches, one after another. The first failure stops the rest.`}
                      disabled={running}
                      onClick={() => openRun(`every mergeable branch of ${p.name}`,
                        all.filter((r) => isMergeable(r.state) && !live(r) && !merged(r)), [])}>
                      {mergeableN} → main
                    </button>
                  )}
                </div>

                {grows.map((r) => (
                  <MergeRowView key={r.key} r={r}
                    selected={!!sel[r.key]} expanded={open === r.key}
                    live={live(r)} merged={merged(r)}
                    reviewNote={(data.reviewNotes ?? []).find((n) => n.slug === r.project.slug && n.branch === r.branch.branch) ?? null}
                    geminiReady={data.geminiReady ?? false}
                    preview={previewFor(r.project.slug, r.branch.branch)}
                    previewBusy={previewBusy === `${r.project.slug}:${r.branch.branch}`}
                    onToggle={() => toggle(r.key)}
                    onExpand={() => setOpen((k) => (k === r.key ? '' : r.key))}
                    onMerge={() => onMerge(r.project, r.branch)}
                    onStartPreview={() => onStartPreview(r.project.slug, r.branch.branch, r.itemId || null)}
                    onStopPreview={onStopPreview} />
                ))}
              </div>
            );
          })}

          {!groups.length && (
            <div className="mc14-empty">
              {rows.length
                ? 'No branch matches this filter.'
                : reportAge
                  ? 'No open branches anywhere — every lane is merged or pruned.'
                  : 'No git report from the host yet, and no open claims. This room is empty because nothing has been reported, not because nothing is open — the dispatcher pushes a report every ~10 minutes.'}
            </div>
          )}
        </div>

        {/* ---- the agent rail ---- */}
        <div className="mc-merge-agent">
          <div className="mc-merge-agenthead">
            <span className="badge">⇄</span>
            <span className="nm">Merge agent</span>
            <span className="st">{running ? 'queueing…' : 'idle'}</span>
          </div>
          <p className="mc-merge-agentnote">
            Orders the mergeable branches so no two in a wave touch the same area, then queues
            them one at a time — each merging into the main the last one produced. It never
            resolves a conflict on its own and never ticks an item: a merge that fails stops
            the run and says where it got to.
          </p>

          <div className="mc-merge-cap">Ordering</div>
          <span className="seg-control sm" role="tablist" aria-label="Wave ordering">
            {([
              ['area', 'Fewest clashes', 'Spread the branches so no wave merges two that touch the same area.'],
              ['age', 'Oldest first', 'Oldest commit first — the branches that have been waiting longest.'],
              ['size', 'Smallest first', 'Smallest diff first — the cheapest merges land before the risky ones.'],
            ] as const).map(([k, label, hint]) => (
              <button key={k} role="tab" aria-selected={order === k} title={hint}
                className={`seg-opt ${order === k ? 'on' : ''}`}
                onClick={() => setOrder(k)}>{label}</button>
            ))}
          </span>

          <div className="mc-merge-cap">Autonomy per project</div>
          <div className="mc-merge-autonomy">
            {data.projects.filter((p) => p.branches.length).map((p) => (
              <div key={p.slug} className="row">
                <i className="sq" style={{ background: p.tint || 'var(--muted)' }} />
                <span className="nm">{p.name}</span>
                <span className="seg-control sm">
                  {(['auto', 'plan', 'off'] as const).map((v) => (
                    <button key={v} className={`seg-opt ${autonomyOf(p) === v ? 'on' : ''}`}
                      title={v === 'auto'
                        ? '▶ Run queues this project’s mergeable branches, in the planned order.'
                        : v === 'plan'
                          ? 'Its branches are named in the plan so the ordering is honest, but ▶ Run leaves them alone — merge them one press each.'
                          : 'Left out of the plan entirely.'}
                      onClick={() => onSetAutonomy(p, v)}>
                      {v === 'auto' ? 'Auto' : v === 'plan' ? 'Plan' : 'Off'}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <div className="mc-merge-plan">
            <div className="hd">Proposed plan</div>
            {flatPlan.length ? (<>
              <p className="txt">
                {flatPlan.length} mergeable branch{flatPlan.length === 1 ? '' : 'es'} in {waves.length} area-disjoint
                wave{waves.length === 1 ? '' : 's'}.{' '}
                {agentHold.length > 0
                  ? `${agentRows.length} of them would be queued by ▶ Run — the other ${agentHold.length} sit in projects set to Plan.`
                  : 'All of them would be queued by ▶ Run.'}
              </p>
              <div className="waves">
                {waves.map((w, i) => (
                  <span key={i} className="w" title={w.map((r) => r.branch.branch).join('\n')}>
                    wave {i + 1} · {w.length}
                  </span>
                ))}
              </div>
            </>) : (
              <p className="txt quiet">
                Nothing to plan. The agent only orders branches the host’s probe says merge
                cleanly — a conflict needs resolving and an unprobed branch has never been asked.
              </p>
            )}
          </div>

          <button className="btn-accent mc-merge-agentgo" disabled={!flatPlan.length}
            onClick={() => openRun('the merge agent’s plan', agentRows, agentHold)}>Open the plan</button>
        </div>
      </div>

      {run && (
        <RunPlanModal what={run.what} order={order}
          runRows={run.rows} hold={run.hold}
          queued={queued} running={running}
          onClose={() => setRun(null)}
          onRun={(rows) => void queueAll(rows)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row of the ledger, and its expansion.

function MergeRowView({
  r, selected, expanded, live, merged, reviewNote, geminiReady, preview, previewBusy,
  onToggle, onExpand, onMerge, onStartPreview, onStopPreview,
}: {
  r: Row;
  selected: boolean; expanded: boolean; live: boolean; merged: boolean;
  reviewNote: { note: string; when: string } | null;
  geminiReady: boolean;
  preview: Preview | null;
  previewBusy: boolean;
  onToggle: () => void; onExpand: () => void; onMerge: () => void;
  onStartPreview: () => void; onStopPreview: (pv: Preview) => void;
}) {
  const meta = MERGE_STATE_META[r.state];
  const total = r.adds + r.dels;
  // The size bar is relative to a fixed 700-line yardstick rather than to the
  // biggest branch on screen: a bar that rescales as branches merge would make
  // the same branch look different from one refresh to the next.
  const width = Math.min(100, Math.round((total / 700) * 100));

  const action = r.state === 'conflict' ? 'Resolve' : '⇥ Merge';

  return (
    <div className={`mc-merge-row-wrap ${expanded ? 'open' : ''}`}>
      <div className={`mc-merge-row s-${r.state} ${merged ? 'done' : ''}`}>
        <button className={`mc-merge-tick ${selected ? 'on' : ''}`} disabled={live || merged}
          aria-label={`Select ${r.branch.branch}`} aria-pressed={selected}
          onClick={onToggle}>{selected ? '✓' : ''}</button>

        <button className="mc-merge-main" onClick={onExpand} aria-expanded={expanded}>
          <i className="dot" style={{ background: meta.tone }} title={meta.hint} />
          <span className="slug">
            {r.kind
              ? <b style={{ color: KIND_TONE[r.kind] }}>{r.kind}/</b>
              : <b className="unlabelled" title="A lane cut before the naming convention — the branch name does not say what kind of change it carries.">…/</b>}
            <span className="nm">{r.label}</span>
          </span>
          {/* Always rendered, empty or not: the row is a GRID and every cell
              after this one is placed by position. A conditional cell would
              shift the state, the size and the area one column left on any
              branch with no item behind it. */}
          <span className="id">{r.itemId ? `#${r.itemId}` : ''}</span>
          <span className="state" style={{ color: meta.tone }}>{meta.label}</span>
          {r.sized ? (<>
            <span className="bar" aria-hidden>
              <i className="a" style={{ width: `${(width * r.adds) / (total || 1)}%` }} />
              <i className="d" style={{ width: `${(width * r.dels) / (total || 1)}%` }} />
            </span>
            <span className="add">+{fmtN(r.adds)}</span>
            <span className="del">−{fmtN(r.dels)}</span>
            <span className="files">{r.files}f</span>
          </>) : (
            <span className="unsized" title="The host's report carried no diff for this branch — either it pre-dates the diff being reported, or this chip is a claim with no branch on origin behind it. Unknown size, not zero.">
              size unknown
            </span>
          )}
          <span className={`area ${r.area ? '' : 'none'}`}
            title={r.area ? `Most of this branch sits under ${r.area}` : 'The report named no area for this branch'}>
            {r.area || '—'}
          </span>
          <span className="age">{r.branch.when || ''}</span>
        </button>

        <div className="mc-merge-acts">
          {!preview ? (
            <button className="ghost" disabled={previewBusy} onClick={onStartPreview}
              title={`Bring ${r.branch.branch} up as an isolated stack on the host, on a temporary public URL.`}>
              {previewBusy ? '◴ …' : '◱ Preview'}
            </button>
          ) : preview.status === 'live' && preview.url ? (
            <span className="mc-merge-pv">
              <a href={preview.url} target="_blank" rel="noopener noreferrer">◱ Open</a>
              <button className="x" aria-label="Stop preview" onClick={() => onStopPreview(preview)}>×</button>
            </span>
          ) : (
            <span className="mc-merge-jobstate">{preview.status === 'stopping' ? 'stopping…' : 'preview building…'}</span>
          )}
          {live ? (
            <span className="mc-merge-jobstate" title={r.job?.detail}>
              {r.job!.status === 'running' ? 'merging…' : 'queued…'}
            </span>
          ) : merged ? (
            <span className="mc-merge-jobstate ok" title={r.job?.detail}>merged</span>
          ) : (
            <button className={`go ${r.state === 'conflict' ? 'warn' : ''}`} onClick={onMerge}
              title={r.state === 'conflict'
                ? 'Open the merge confirm — the host’s probe says this conflicts, so the dialog offers the AI-assisted resolution.'
                : `Merge origin/${r.branch.branch} into main on the host. Conflicts fail safely.`}>
              {action}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mc-merge-detail">
          <div className="col">
            <div className="cap">Files touched</div>
            {r.branch.topFiles?.length ? (<>
              {r.branch.topFiles.map((f) => (
                <div key={f.path} className="frow">
                  <span className="p">{f.path}</span>
                  {f.binary
                    ? <span className="s quiet">binary</span>
                    : <span className="s">+{f.adds} −{f.dels}</span>}
                </div>
              ))}
              {r.files > r.branch.topFiles.length && (
                <div className="frow more">
                  … {r.files - r.branch.topFiles.length} more of {r.files} files — the report keeps
                  the {r.branch.topFiles.length} biggest
                </div>
              )}
            </>) : (
              <div className="frow more">
                The report carried no file list for this branch.
              </div>
            )}
          </div>

          <div className="col wide">
            <div className="cap">What is known about this branch</div>
            <div className="mc-merge-verdict">
              <p>{meta.hint}</p>
              {r.itemTitle && (
                <p className="item">
                  <button onClick={() => go.detail(r.project.slug, 'roadmap', r.itemId)}>#{r.itemId} {r.itemTitle}</button>
                </p>
              )}
              {r.branch.subject && <p className="subj">Last commit: “{r.branch.subject}”</p>}
              {/* The reviewer's line is the only durable trace of the second
                  model's read of this push. Absent is stated as absent — an
                  empty reviewer is NOT a clean one (the NULL-verdict rule). */}
              {reviewNote?.note ? (
                <p className="rev"><b>Reviewer, {reviewNote.when}:</b> {reviewNote.note}</p>
              ) : (
                <p className="rev quiet">
                  {geminiReady
                    ? 'NO REVIEW — the second model has not annotated a push on this branch. That is not the same as a clean read.'
                    : 'No reviewer configured, so nothing has read this diff but the conflict probe.'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The run modal. It opens on the PLAN, not on a run: queueing merges to main
// across the whole house is not something a single click should start, so the
// press that starts it is inside the dialog, under the list of exactly what it
// will do. After that the dialog reports how far the queueing got — the merges
// themselves run on the dispatcher's clock and report back into the ledger.

function RunPlanModal({ what, order, runRows, hold, queued, running, onClose, onRun }: {
  what: string;
  order: 'area' | 'age' | 'size';
  runRows: Row[];
  hold: Row[];
  queued: Record<string, string>;
  running: boolean;
  onClose: () => void;
  onRun: (rows: Row[]) => void;
}) {
  // The dialog re-plans over exactly the branches it is about, so a scoped run
  // (one project, or the ticked rows) shows its OWN waves rather than the
  // agent's house-wide ordering with most of it missing.
  const waves = planWaves([...runRows, ...hold], order);
  // What THIS press queues. Normally the auto rows; when the plan is entirely
  // held (every project set to Plan, which is the default) the held rows are
  // what the press queues instead — because you are standing in front of the
  // full list, which is the moment Plan exists to reach. The copy says which
  // of the two is happening; the dialog is never a dead end.
  const holdOnly = runRows.length === 0 && hold.length > 0;
  const willQueue = holdOnly ? hold : runRows;
  const inRun = new Set(willQueue.map((r) => r.key));
  const done = willQueue.filter((r) => queued[r.key] === '').length;
  const failed = willQueue.filter((r) => queued[r.key]).length;
  const started = done + failed > 0;

  return (
    <div className="overlay" onClick={() => !running && onClose()}>
      <div className="modal mc-merge-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Merge agent — {started ? 'queued' : 'the plan'}</h3>
        <p className="mc-merge-modalsub">
          {willQueue.length} branch{willQueue.length === 1 ? '' : 'es'} from {what} into <code>main</code>, in {waves.length} area-disjoint
          wave{waves.length === 1 ? '' : 's'}. Each queues a merge job; the host runs them one at a
          time, merging into the main the last one produced, deleting the remote branch as it goes.
          The first failure stops the rest. Nothing is ticked — the verdict stays yours.
          {holdOnly
            ? <> Every project in this plan is set to <b>Plan</b>, which is why nothing was queued on
                the press: Plan means the agent shows you the list first. Queueing from here is that
                confirmation. Set a project to <b>Auto</b> in the rail to skip this step for it.</>
            : hold.length > 0
              ? <> {hold.length} more {hold.length === 1 ? 'is' : 'are'} in the plan for ordering but held back: their project is set to Plan.</>
              : null}
        </p>

        <div className="mc-merge-steps">
          {waves.map((w, i) => (
            <div key={i} className="wave">
              <div className="whead">Wave {i + 1}<span>{w.length} branch{w.length === 1 ? '' : 'es'} · no two in one area</span></div>
              {w.map((r) => {
                const q = queued[r.key];
                const state = q === '' ? 'ok' : q ? 'bad' : started ? 'skipped' : 'wait';
                const isIn = inRun.has(r.key);
                return (
                  <div key={r.key} className={`step ${state} ${isIn ? '' : 'held'}`}>
                    <span className="ic">{q === '' ? '✓' : q ? '×' : isIn ? '•' : '·'}</span>
                    <span className="sl">{r.branch.branch}</span>
                    <span className="ar">{r.area || '—'}</span>
                    <span className="st">
                      {q === '' ? 'merge queued' : q ? q : isIn ? (started ? 'not reached' : 'will queue') : 'not in this press'}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn-cancel" disabled={running} onClick={onClose}>
            {started ? 'Close' : 'Cancel'}
          </button>
          <button className="btn-submit" disabled={running || started || !willQueue.length}
            onClick={() => onRun(willQueue)}>
            {running ? 'Queueing…' : started ? `${done} queued${failed ? `, ${failed} failed` : ''}`
              : holdOnly ? `Queue ${willQueue.length} held merge${willQueue.length === 1 ? '' : 's'}`
              : `Queue ${willQueue.length} merge${willQueue.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
