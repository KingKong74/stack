import { useMemo, useState } from 'react';
import type { ControlData } from '../store';
import { go } from '../lib/route';
import {
  buildFeatures, worktreesUnseen, STAGES, STAGE_META, FLAG_META,
  type Feature, type FeatureStage, type FeatureFlag,
} from '../lib/feature';
import { KIND_TONE, KIND_HINT, MERGE_STATE_META } from '../lib/branch';

// ---------------------------------------------------------------------------
// #365 — the TREES room: one place surfacing the current status of every
// in-progress feature, across claims, branches and worktrees.
//
// The Merge room groups by PROJECT because its question is "what is waiting
// to land". This room groups by STAGE because its question is different —
// "where has each feature actually got to" — and the pipeline (claimed →
// building → built → pushed → landed) is the spine that answers that.
//
// Read-only by construction: it takes the control payload the shell already
// fetched (`lib/feature.ts` does the derivation, pure and already tested) and
// renders it. Nothing here mutates a claim, a branch or a tree — merging,
// previewing and autonomy stay the Now/Merge rooms' job.
// ---------------------------------------------------------------------------

const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function TreesRoom({ data }: { data: ControlData }) {
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState<FeatureStage | 'all'>('all');
  const [flagFilter, setFlagFilter] = useState<FeatureFlag | ''>('');
  const [projFilter, setProjFilter] = useState('');   // '' = the whole house
  const [open, setOpen] = useState('');               // the expanded row's key

  const features = useMemo(
    () => buildFeatures(data.projects, data.fleet?.slots ?? []),
    [data.projects, data.fleet]);

  // (#365) A project the host has never reported worktrees for must be named,
  // not silently rendered as having none — missing data is never good news.
  const unseen = worktreesUnseen(data.projects);
  const unseenNames = unseen.map((slug) => data.projects.find((p) => p.slug === slug)?.name || slug);

  const inFlight = features.filter((f) => f.stage !== 'landed');

  const stageCounts = useMemo(() => {
    const c: Record<string, number> = { all: features.length };
    for (const s of STAGES) c[s] = 0;
    for (const f of features) c[f.stage]++;
    return c;
  }, [features]);

  const flagCounts = useMemo(() => {
    const c = new Map<FeatureFlag, number>();
    for (const f of features) for (const fl of f.flags) c.set(fl, (c.get(fl) ?? 0) + 1);
    return c;
  }, [features]);

  const needle = q.trim().toLowerCase().replace(/^#/, '');
  const visible = features.filter((f) =>
    (stageFilter === 'all' || f.stage === stageFilter)
    && (!flagFilter || f.flags.includes(flagFilter))
    && (!projFilter || f.slug === projFilter)
    && (!needle
      || f.title.toLowerCase().includes(needle)
      || f.branch.toLowerCase().includes(needle)
      || f.itemId.toLowerCase().includes(needle)));

  // The dispatcher's git pass and the worktree scan are two separate reads —
  // each project carries its own age, but the header states one line per
  // read (the first reported one) rather than pretending every project's
  // report landed at the same moment. Same convention as the Merge room.
  const branchesWhen = data.projects.map((p) => p.branchesWhen).find(Boolean) || '';
  const worktreesWhen = data.projects.map((p) => p.worktreesWhen).find((w): w is string => !!w) || '';

  const groups = STAGES
    .map((s) => ({ s, rows: visible.filter((f) => f.stage === s) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="mc-trees">
      {/* ---- header ---- */}
      <div className="mc14-room-head mc-merge-head">
        <span className="title">Trees</span>
        <span className="meta">
          {inFlight.length} feature{inFlight.length === 1 ? '' : 's'} in flight · {data.projects.length} project{data.projects.length === 1 ? '' : 's'}
        </span>
        <span className="meta"
          title="The host dispatcher fetches each repo and re-probes every ~10 minutes. Branch state, size and area are from that pass, not from this page load.">
          {branchesWhen ? `git as of ${branchesWhen}` : 'no git report from the host yet'}
        </span>
        <span className="meta"
          title="A separate host scan of every parallel checkout — uncommitted work and commits no ref has ever seen.">
          {worktreesWhen ? `trees as of ${worktreesWhen}` : 'no worktree report from the host yet'}
        </span>
      </div>

      {unseen.length > 0 && (
        <div className="mc-trees-unseen">
          Stack cannot see the host’s worktrees for: {unseenNames.join(', ')} — uncommitted work there is invisible.
        </div>
      )}

      {/* ---- filters ---- */}
      <div className="mc-merge-filters">
        <button className={`mc-merge-chip ${stageFilter === 'all' ? 'on' : ''}`}
          onClick={() => setStageFilter('all')}>
          All<span className="n">{stageCounts.all}</span>
        </button>
        {STAGES.map((s) => (
          <button key={s} className={`mc-merge-chip ${stageFilter === s ? 'on' : ''}`}
            title={STAGE_META[s].hint} onClick={() => setStageFilter(s)}>
            <i style={{ background: STAGE_META[s].tone }} />
            {STAGE_META[s].label}<span className="n">{stageCounts[s]}</span>
          </button>
        ))}
        {flagCounts.size > 0 && <span className="mc-merge-sep" />}
        {(Object.keys(FLAG_META) as FeatureFlag[]).filter((fl) => flagCounts.get(fl)).map((fl) => (
          <button key={fl} className={`mc-merge-chip ${flagFilter === fl ? 'on' : ''}`}
            title={FLAG_META[fl].hint} onClick={() => setFlagFilter((v) => (v === fl ? '' : fl))}>
            <i style={{ background: FLAG_META[fl].tone }} />
            {FLAG_META[fl].label}<span className="n">{flagCounts.get(fl)}</span>
          </button>
        ))}
        <span className="mc-merge-sep" />
        <button className={`mc-merge-chip proj ${!projFilter ? 'on' : ''}`} onClick={() => setProjFilter('')}>
          All projects
        </button>
        {data.projects.filter((p) => features.some((f) => f.slug === p.slug)).map((p) => (
          <button key={p.slug} className={`mc-merge-chip proj ${projFilter === p.slug ? 'on' : ''}`}
            onClick={() => setProjFilter(p.slug)}>
            <i className="sq" style={{ background: p.tint || 'var(--muted)' }} />{p.name}
          </button>
        ))}
        <input className="mc-merge-q" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="filter features" aria-label="Filter features" />
      </div>

      {/* ---- the list, grouped by STAGE — the pipeline is the spine ---- */}
      <div className="mc-merge-list">
        {groups.map(({ s, rows }) => (
          <div key={s} className="mc-merge-group">
            <div className="mc-trees-stagehead">
              <div className="top">
                <i className="dot" style={{ background: STAGE_META[s].tone }} />
                <span className="nm">{STAGE_META[s].label}</span>
                <span className="meta">{rows.length} feature{rows.length === 1 ? '' : 's'}</span>
              </div>
              <p className="hint">{STAGE_META[s].hint}</p>
            </div>
            {rows.map((f) => (
              <FeatureRowView key={f.key} f={f} expanded={open === f.key}
                onExpand={() => setOpen((k) => (k === f.key ? '' : f.key))} />
            ))}
          </div>
        ))}

        {!groups.length && (
          <div className="mc14-empty">
            {features.length
              ? 'No feature matches this filter.'
              : unseen.length > 0
                ? 'Nothing to show — Stack cannot see the host’s worktrees, so this may be missing in-flight work rather than there being none.'
                : 'Nothing is in flight — every claim is finished, and no worktree holds unpublished work.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One feature, one row, expandable — mirrors the Merge room's row/detail
// interaction (MergeRowView) but a plain div, not a button: the collapsed row
// carries a real link (the #id) inside it, and two interactive elements
// cannot nest inside one <button>.

function FeatureRowView({ f, expanded, onExpand }: { f: Feature; expanded: boolean; onExpand: () => void }) {
  const planPct = f.planTotal > 0 ? Math.round((f.planDone / f.planTotal) * 100) : 0;
  const mstate = MERGE_STATE_META[f.mergeState];

  return (
    <div className={`mc-merge-row-wrap ${expanded ? 'open' : ''}`}>
      <div className="mc-trees-row" role="button" tabIndex={0} aria-expanded={expanded}
        onClick={onExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); } }}>

        <span className="proj" title={f.project}>
          <i className="sq" style={{ background: f.tint || 'var(--muted)' }} />
          <span>{f.project}</span>
        </span>

        <span className="slug">
          {f.kind
            ? <b style={{ color: KIND_TONE[f.kind] }} title={KIND_HINT[f.kind]}>{f.kind}/</b>
            : <b className="unlabelled" title="A lane cut before the naming convention says nothing about what kind of change it carries.">…/</b>}
          <span className="nm">{f.title}</span>
        </span>

        {f.itemId && (
          <button className="id" onClick={(e) => { e.stopPropagation(); go.detail(f.slug, 'roadmap', f.itemId); }}>
            #{f.itemId}
          </button>
        )}

        {f.planTotal > 0 && (
          <span className="plan" title={`${f.planDone} of ${f.planTotal} plan steps done`}>
            <span className="bar" aria-hidden><i style={{ width: `${planPct}%` }} /></span>
            <span className="txt">{f.planDone}/{f.planTotal} steps</span>
          </span>
        )}

        {f.live && <i className="live-pulse" title="A fleet worker is on this right now." />}

        <span className={`tree ${f.tree ? '' : 'none'}`}>
          {f.tree ? (<>
            <b>{f.tree.name}</b>
            {f.tree.dirty > 0 && <i className="dirty">⌂ {f.tree.dirty} uncommitted</i>}
            {f.tree.unpushed === null
              ? <i className="never">never pushed</i>
              : f.tree.unpushed > 0 ? <i className="unpushed">↑ {f.tree.unpushed} unpushed</i> : null}
          </>) : 'no tree'}
        </span>

        {f.branch && (
          <span className="diff">
            <span className="sz"><span className="add">+{fmtN(f.adds)}</span> <span className="del">−{fmtN(f.dels)}</span></span>
            <span className="ab">↑{f.ahead} ↓{f.behind}</span>
          </span>
        )}

        {f.flags.length > 0 && (
          <span className="flags">
            {f.flags.map((fl) => (
              <i key={fl} className="flag" style={{ color: FLAG_META[fl].tone, borderColor: FLAG_META[fl].tone }}
                title={FLAG_META[fl].hint}>{FLAG_META[fl].label}</i>
            ))}
          </span>
        )}

        <span className="age">{f.when || ''}</span>
      </div>

      {expanded && (
        <div className="mc-merge-detail">
          <div className="col wide">
            <div className="cap">What is known about this feature</div>
            <div className="mc-merge-verdict">
              {f.tree ? (<>
                <p className="subj">Worktree: <code>{f.tree.path}</code></p>
                <p className="subj">HEAD {f.tree.head ? f.tree.head.slice(0, 7) : '—'} — “{f.tree.subject || 'no commit yet'}”</p>
                {f.tree.prunable && <p>The tree’s directory is gone — ready to be pruned.</p>}
              </>) : (
                <p className="subj quiet">No worktree behind this feature.</p>
              )}

              {f.builtNote ? (
                <p><b>What landed:</b> {f.builtNote}</p>
              ) : (f.stage === 'pushed' || f.stage === 'landed') ? (
                <p className="quiet">No built note.</p>
              ) : null}

              {/* An empty review is never a pass — same rule the Merge room's
                  reviewer note applies (a NULL verdict reads as NO REVIEW,
                  never as green). */}
              {f.reviewTag ? (
                <p className="rev"><b>Review:</b> {f.reviewTag}</p>
              ) : (
                <p className="rev quiet">NO REVIEW — nobody has verdicted this item yet. That is not the same as a clean pass.</p>
              )}

              <p className="subj">
                Tier {f.tier || 'unranked'} · Bucket {f.bucket || '—'} · Risk {f.risk || '—'} · Area {f.area || '—'}
              </p>

              <p className="rev" style={{ borderLeftColor: mstate.tone }}>
                <b style={{ color: mstate.tone }}>{mstate.label}</b> — {mstate.hint}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
