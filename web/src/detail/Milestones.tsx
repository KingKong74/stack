// MILESTONES — the project's milestones as a destination of their own, beside
// the Charter (which keeps purpose, principles and boundaries). Everything here
// reads the real `milestones` and `slices` rows from the project payload and
// writes through routes/spine.js; there is no Markdown copy of them anywhere.
//
// The server's lifecycle rules are SAID here, never re-implemented:
//  • At most one milestone is current; making another current FINISHES the
//    incumbent in the same write, and the button says so before the press.
//  • Deleting a milestone removes its slices, keeps items in the Icebox and
//    clears Ready. The confirmation says so before the write.
//  • A slice's state is `sliceStateOf`, derived from its items.
//
// `MilestoneSummary` is the Charter's right-hand rail: the current milestone
// and what is next, linking here. It collapses under the doc on narrow screens.
//
// THE LOOK is Milestones.dc.html: the current milestone as one wide card (goal
// and "Done when" on the left, its slices on the right), the upcoming ones as
// a grid. A goal's "Done when:" paragraph is read by `splitGoal`
// (lib/archDoc.ts); a goal without one is all goal. Numbers (01, 02 …) are
// the display order, current first; a completed milestone carries none.

import { useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { Milestone, RoadmapItem, Slice } from '../types';
import { createMilestone, patchMilestone, deleteMilestone } from '../store';
import { sliceStateOf, type SliceState } from '../lib/plan';
import { hrefTo } from '../lib/route';
import { pad2, splitGoal } from '../lib/archDoc';

type Fields = { name: string; goal: string; targetOn: string | null };

/** A slice's chip: the state is derived (`sliceStateOf`), never stored. */
function SliceChip({ st }: { st: SliceState }) {
  const [tone, label] = st.status === 'empty' ? ['empty', 'empty']
    : st.status === 'done' ? ['ok', 'done']
    : st.status === 'built' ? ['ok', `${st.built}/${st.total} built`]
    : ['open', `${st.built}/${st.total} built`];
  return <span className={`ms-chip ${tone}`}>{label}</span>;
}

/** One segment per slice: built or done is filled, empty is faint. */
function SliceBar({ states }: { states: SliceState[] }) {
  if (!states.length) return null;
  return (
    <div className="ms-bar" style={{ gridTemplateColumns: `repeat(${states.length}, 1fr)` }} aria-hidden>
      {states.map((st, i) => <span key={i} className={st.status === 'empty' ? 'empty' : st.status === 'open' ? 'open' : 'full'} />)}
    </div>
  );
}

function tally(states: SliceState[]) {
  return { built: states.reduce((n, s) => n + s.built, 0), total: states.reduce((n, s) => n + s.total, 0) };
}

export function Milestones({ slug, milestones, slices, items, onRefresh }: {
  slug: string; milestones: Milestone[]; slices: Slice[]; items: RoadmapItem[]; onRefresh: () => void;
}) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); onRefresh(); } catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const cur = milestones.filter((m) => m.status === 'active');
  const next = milestones.filter((m) => m.status === 'planned');
  const done = milestones.filter((m) => m.status === 'done');
  const incumbent = cur[0] ?? null;
  const card = (m: Milestone, n: number | null, wide: boolean) => (
    <MilestoneCard key={m.id} slug={slug} m={m} n={n} wide={wide} incumbent={incumbent} busy={busy}
      slices={slices.filter((s) => s.milestoneId === m.id)} items={items}
      onSave={(v) => guard(() => patchMilestone(slug, m.id, v))}
      onStatus={(status) => guard(() => patchMilestone(slug, m.id, { status }))}
      onDelete={() => guard(() => deleteMilestone(slug, m.id))} />
  );
  const head = (label: string, count: number) => (
    <div className="ms-grouphead"><span className="sp-eyebrow">{label}</span><span className="sp-when">{count}</span><span className="ms-hr" /></div>
  );
  return (
    <div className="sp ms">
      <div className="ms-top">
        <div className="ms-intro">
          <span className="sp-when">{milestones.length} milestone{milestones.length === 1 ? '' : 's'}</span>
          <p>Where the project is going, one goal at a time. Slices belong to a milestone; at most one is current.
            The <a href={hrefTo.detail(slug, 'charter')}>Charter</a> holds the purpose and boundaries.</p>
        </div>
        {!adding && <button className="k-btn" onClick={() => setAdding(true)}><KitIcon name="plus" size={13} />New milestone</button>}
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}
      {adding && (
        <MilestoneForm initial={{ name: '', goal: '', targetOn: null }} busy={busy} submitLabel="Create"
          onCancel={() => setAdding(false)}
          onSubmit={(v) => guard(async () => { await createMilestone(slug, { ...v, status: 'planned' }); setAdding(false); })} />
      )}
      {milestones.length === 0 && !adding && (
        <div className="sp-doc empty">
          <span className="sp-empty">No milestones yet. A milestone names what is true when the next stretch of work is
            done; the board's slices are filed under it. Make one here, or the first slice you create on the board will
            make a “Current” one for you.</span>
        </div>
      )}
      {milestones.length > 0 && <>
        <section className="ms-group" aria-label="Current">
          {head('Current', cur.length)}
          {cur.length === 0 && <span className="sp-empty">Nothing is current. Make an upcoming milestone current to file new slices under it.</span>}
          {cur.map((m, i) => card(m, i + 1, true))}
        </section>
        <section className="ms-group" aria-label="Upcoming">
          {head('Upcoming', next.length)}
          {next.length === 0 && <span className="sp-empty">Nothing planned after this one.</span>}
          {next.length > 0 && <div className="ms-grid">{next.map((m, i) => card(m, cur.length + i + 1, false))}</div>}
        </section>
        {done.length > 0 && (
          <section className="ms-group" aria-label="Completed">
            {head('Completed', done.length)}
            <div className="ms-grid">{done.map((m) => card(m, null, false))}</div>
          </section>
        )}
      </>}
    </div>
  );
}

const PILL: Record<Milestone['status'], { label: string; tone: string }> = {
  active: { label: 'Current', tone: 'success' },
  planned: { label: 'Upcoming', tone: 'info' },
  done: { label: 'Completed', tone: 'neutral' },
};

function MilestoneCard({ slug, m, n, wide, incumbent, slices, items, busy, onSave, onStatus, onDelete }: {
  slug: string; m: Milestone; n: number | null; wide: boolean; incumbent: Milestone | null; slices: Slice[];
  items: RoadmapItem[]; busy: boolean;
  onSave: (v: Fields) => void; onStatus: (s: Milestone['status']) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const live = slices.filter((s) => !s.archived);
  const states = live.map((s) => sliceStateOf(s.id, items));
  const { built, total } = tally(states);
  const { goal, done, more } = splitGoal(m.goal);
  const pill = PILL[m.status];
  if (editing) {
    return (
      <MilestoneForm initial={{ name: m.name, goal: m.goal, targetOn: m.targetOn }} busy={busy} submitLabel="Save"
        onCancel={() => setEditing(false)} onSubmit={(v) => { onSave(v); setEditing(false); }} />
    );
  }
  const edit = (
    <button className={`k-btn sm ${wide ? 'ghost ms-edit' : 'ghost ms-editlink'}`} onClick={() => setEditing(true)} aria-label={`Edit milestone ${m.name}`}>
      <KitIcon name="pencil" size={13} />Edit
    </button>
  );
  const sliceRows = live.map((s, i) => (
    <a key={s.id} href={hrefTo.detail(slug, 'roadmap')} className="ms-slicerow">
      <span className="ms-slicename">{wide && <span className="sp-when">{pad2(i + 1)}</span>}{s.title}</span>
      <SliceChip st={states[i]} />
    </a>
  ));
  const deleteAction = (
    <button className="k-btn sm danger ms-del" disabled={busy} onClick={() => (confirm ? onDelete() : setConfirm(true))}>
      {confirm ? 'Confirm delete' : 'Delete'}
    </button>
  );
  const statusAction = m.status === 'planned' ? (
    <div className="ms-action">
      <button className="k-btn sm secondary" disabled={busy} onClick={() => onStatus('active')}>Make current</button>
      {incumbent && <span className="sp-foot">Finishes “{incumbent.name}”</span>}
    </div>
  ) : m.status === 'active' ? (
    <button className="k-btn sm accent" disabled={busy} onClick={() => onStatus('done')}>Mark completed</button>
  ) : (
    <button className="k-btn sm ghost" disabled={busy} onClick={() => onStatus('planned')}>Reopen as upcoming</button>
  );
  const meta = (
    <div className="ms-meta">
      {n !== null && <span className={`ms-n${wide ? ' accent' : ''}`}>{pad2(n)}</span>}
      <span className={`doc-pill ${pill.tone}`}>{pill.label}</span>
      {m.targetOn && <span className="sp-when" title="A target you set. It gates nothing.">by {m.targetOn}</span>}
    </div>
  );
  const moreView = more && (
    <details className="ms-more"><summary>More</summary><div className="ar-md"><Markdown text={more} /></div></details>
  );

  if (wide) {
    return (
      <article className="ms-current" aria-label={`Milestone ${m.name}`}>
        <div className="ms-main">
          <div className="ms-titlerow">
            <div className="ms-titles">{meta}<h2 className="ms-title">{m.name}</h2></div>
            {edit}
          </div>
          {goal ? <div className="ms-goal big"><Markdown text={goal} /></div> : <span className="sp-empty">No goal written yet.</span>}
          {done && (
            <div className="ms-donebox"><span className="sp-eyebrow">Done when</span><p>{done}</p></div>
          )}
          {moreView}
          {confirm && <p className="sp-foot" role="alert">Delete “{m.name}” and its {slices.length} slices? Items are kept in the Icebox and leave Ready. This cannot be undone.
            {' '}<button className="k-btn sm ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel deletion</button></p>}
          <div className="ms-foot">{statusAction}{deleteAction}</div>
        </div>
        <div className="ms-side">
          <div className="ms-sidehead">
            <span className="sp-eyebrow">Slices · <span className="sp-mono">{live.length}</span></span>
            <span className="sp-when"><b>{built}</b>/{total} built</span>
          </div>
          <SliceBar states={states} />
          {live.length === 0 ? <span className="sp-empty">No slices in this milestone.</span> : <div className="ms-slicerows">{sliceRows}</div>}
        </div>
      </article>
    );
  }
  return (
    <article className={`ms-card2${m.status === 'done' ? ' done' : ''}`} aria-label={`Milestone ${m.name}`}>
      <div className="ms-titlerow">
        <div className="ms-titles">{meta}<h3 className="ms-title sm">{m.name}</h3></div>
        {edit}
      </div>
      {goal || done ? <>
        {goal && <div className="ms-goal"><Markdown text={goal} /></div>}
        {done && <div className="ms-donerule"><span className="sp-eyebrow">Done when</span><p>{done}</p></div>}
        {moreView}
      </> : (
        <div className="ms-nogoal">
          <span>No goal written yet.</span>
          <button className="sp-link" onClick={() => setEditing(true)}>Write the goal</button>
        </div>
      )}
      <div className="ms-slices2">
        <span className="sp-eyebrow">Slices · <span className="sp-mono">{live.length}</span></span>
        {live.length === 0 ? <span className="sp-empty">No slices in this milestone.</span> : sliceRows}
      </div>
      {confirm && <p className="sp-foot" role="alert">Delete “{m.name}” and its {slices.length} slices? Items are kept in the Icebox and leave Ready. This cannot be undone.
        {' '}<button className="k-btn sm ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel deletion</button></p>}
      <div className="ms-foot">{statusAction}{deleteAction}</div>
    </article>
  );
}

function MilestoneForm({ initial, busy, submitLabel, onSubmit, onCancel }: {
  initial: Fields; busy: boolean; submitLabel: string; onSubmit: (v: Fields) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [goal, setGoal] = useState(initial.goal);
  const [targetOn, setTargetOn] = useState(initial.targetOn ?? '');
  const submit = () => { const n = name.trim(); if (n) onSubmit({ name: n, goal, targetOn: targetOn || null }); };
  return (
    <div className="sp-doc ms-form">
      <label className="km-field">
        <span className="lbl">Name</span>
        <span className="searchbox km-input">
          <input autoFocus value={name} placeholder="e.g. Public beta" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
        </span>
      </label>
      <label className="km-field">
        <span className="lbl">Goal</span>
        <textarea className="km-textarea" rows={4} value={goal} placeholder={"Markdown. What this milestone is for.\n\nDone when: what is true when it is finished."}
          onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label className="km-field">
        <span className="lbl">Target</span>
        <input className="km-select ms-date" type="date" value={targetOn} onChange={(e) => setTargetOn(e.target.value)} />
      </label>
      <div className="sp-docacts">
        <button className="k-btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="k-btn sm" disabled={busy || !name.trim()} onClick={submit}>{submitLabel}</button>
      </div>
    </div>
  );
}

/** The Charter's side rail: the current milestone and the next ones. */
export function MilestoneSummary({ slug, milestones, slices, items }: {
  slug: string; milestones: Milestone[]; slices: Slice[]; items: RoadmapItem[];
}) {
  const cur = milestones.find((m) => m.status === 'active') ?? null;
  const planned = milestones.filter((m) => m.status === 'planned');
  const next = planned.slice(0, 3);
  const live = cur ? slices.filter((s) => s.milestoneId === cur.id && !s.archived) : [];
  const states = live.map((s) => sliceStateOf(s.id, items));
  const { built, total } = tally(states);
  const goal = cur ? splitGoal(cur.goal).goal.split('\n')[0] : '';
  const all = hrefTo.detail(slug, 'milestones');
  return (
    <>
      <div className="ch-box card" aria-label="Current milestone">
        <div className="ch-boxhead">
          <span className="sp-eyebrow">Current milestone</span>
          {cur && <span className="doc-pill info">Active</span>}
        </div>
        {cur ? <>
          <a className="ch-msname" href={all}>{cur.name}</a>
          {goal && <p className="ch-msgoal">{goal}</p>}
          <div className="ch-mstally">
            <div className="ms-sidehead">
              <span className="sp-when">{live.length} slice{live.length === 1 ? '' : 's'}{cur.targetOn ? ` · by ${cur.targetOn}` : ''}</span>
              <span className="sp-when"><b>{built}</b>/{total} built</span>
            </div>
            <SliceBar states={states} />
          </div>
        </> : <span className="sp-empty">None current.</span>}
      </div>
      <div className="ch-box list" aria-label="Upcoming milestones">
        <span className="sp-eyebrow">Upcoming</span>
        {next.length === 0 && <span className="sp-empty">Nothing planned.</span>}
        {next.map((m, i) => (
          <a key={m.id} className="ch-up" href={all}><span className="doc-n">{pad2(i + (cur ? 2 : 1))}</span>{m.name}</a>
        ))}
        <a className="ch-all" href={all}>All milestones →</a>
      </div>
    </>
  );
}
