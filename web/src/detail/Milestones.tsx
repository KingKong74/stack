// MILESTONES — the project's milestones as a destination of their own, beside
// the Charter (which keeps purpose, principles and boundaries). Everything here
// reads the real `milestones` and `slices` rows from the project payload and
// writes through routes/spine.js; there is no Markdown copy of them anywhere.
//
// The server's lifecycle rules are SAID here, never re-implemented:
//  • At most one milestone is current; making another current FINISHES the
//    incumbent in the same write, and the button says so before the press.
//  • A milestone that holds slices cannot be deleted (a 409), so Delete is
//    offered only on an empty one and says why otherwise.
//  • A slice's state is `sliceStateOf`, derived from its items.
//
// `MilestoneSummary` is the Charter's right-hand rail: the current milestone
// and what is next, linking here. It collapses under the doc on narrow screens.

import { useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { Milestone, RoadmapItem, Slice } from '../types';
import { createMilestone, patchMilestone, deleteMilestone } from '../store';
import { sliceStateOf } from '../lib/plan';
import { hrefTo } from '../lib/route';

const STATUS_LABEL: Record<Milestone['status'], { label: string; tone: string }> = {
  active: { label: 'Current', tone: 'success' },
  planned: { label: 'Upcoming', tone: 'info' },
  done: { label: 'Completed', tone: '' },
};

type Fields = { name: string; goal: string; targetOn: string | null };

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
  const group = (label: string, list: Milestone[], empty: string) => (
    <section className="sp-sec" aria-label={label}>
      <div className="sp-sechead"><span className="sp-eyebrow">{label}</span><span className="sp-dim">{list.length}</span></div>
      {list.length === 0 && <span className="sp-empty">{empty}</span>}
      {list.map((m) => (
        <MilestoneCard key={m.id} slug={slug} m={m} incumbent={incumbent} busy={busy}
          slices={slices.filter((s) => s.milestoneId === m.id)} items={items}
          onSave={(v) => guard(() => patchMilestone(slug, m.id, v))}
          onStatus={(status) => guard(() => patchMilestone(slug, m.id, { status }))}
          onDelete={() => guard(() => deleteMilestone(slug, m.id))} />
      ))}
    </section>
  );
  return (
    <div className="sp ms">
      <div className="sp-lede">
        <span>Where the project is going, one goal at a time. Slices belong to a milestone; at most one is current.
          The Charter holds the purpose and boundaries.</span>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}
      <div className="sp-docacts top">
        <span className="sp-dim">{milestones.length} milestone{milestones.length === 1 ? '' : 's'}</span>
        {!adding && <button className="k-btn sm" onClick={() => setAdding(true)}><KitIcon name="plus" size={13} />New milestone</button>}
      </div>
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
        {group('Current', cur, 'Nothing is current. Make an upcoming milestone current to file new slices under it.')}
        {group('Upcoming', next, 'Nothing planned after this one.')}
        {group('Completed', done, 'No milestone finished yet.')}
      </>}
    </div>
  );
}

function MilestoneCard({ slug, m, incumbent, slices, items, busy, onSave, onStatus, onDelete }: {
  slug: string; m: Milestone; incumbent: Milestone | null; slices: Slice[]; items: RoadmapItem[]; busy: boolean;
  onSave: (v: Fields) => void; onStatus: (s: Milestone['status']) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const st = STATUS_LABEL[m.status];
  const live = slices.filter((s) => !s.archived);
  if (editing) {
    return (
      <MilestoneForm initial={{ name: m.name, goal: m.goal, targetOn: m.targetOn }} busy={busy} submitLabel="Save"
        onCancel={() => setEditing(false)} onSubmit={(v) => { onSave(v); setEditing(false); }} />
    );
  }
  return (
    <article className="sp-doc ms-card" aria-label={`Milestone ${m.name}`}>
      <div className="ms-head">
        <span className="ms-name">{m.name}</span>
        <span className={`k-tag ${st.tone}`}>{st.label}</span>
        {m.targetOn && <span className="k-tag" title="A target you set. It gates nothing.">by {m.targetOn}</span>}
        <span className="sp-rule" />
        <button className="k-btn ghost sm" onClick={() => setEditing(true)} aria-label={`Edit milestone ${m.name}`}>
          <KitIcon name="pencil" size={13} />Edit
        </button>
      </div>
      {m.goal.trim() ? <Markdown text={m.goal} /> : <span className="sp-empty">No goal written yet.</span>}
      <div className="ms-slices">
        <span className="sp-eyebrow">Slices · {live.length}</span>
        {live.length === 0 && <span className="sp-empty">No slices in this milestone.</span>}
        {live.length > 0 && (
          <ul className="ms-slicelist">
            {live.map((s) => {
              const state = sliceStateOf(s.id, items);
              return (
                <li key={s.id}>
                  <a href={hrefTo.detail(slug, 'roadmap')} className="ms-slice">{s.title}</a>
                  <span className="sp-dim">{state.status === 'empty' ? 'empty' : `${state.built}/${state.total} built`}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="sp-docacts">
        {m.status !== 'active' && (
          <button className="k-btn sm secondary" disabled={busy} onClick={() => onStatus('active')}
            title={incumbent ? `Finishes “${incumbent.name}”` : undefined}>
            Make current{incumbent ? ` (finishes “${incumbent.name}”)` : ''}
          </button>
        )}
        {m.status === 'active' && <button className="k-btn sm secondary" disabled={busy} onClick={() => onStatus('done')}>Mark completed</button>}
        {m.status === 'done' && <button className="k-btn sm ghost" disabled={busy} onClick={() => onStatus('planned')}>Reopen as upcoming</button>}
        {slices.length === 0 ? (
          <button className="k-btn sm danger" disabled={busy} onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? 'Really delete?' : 'Delete'}
          </button>
        ) : (
          <span className="sp-dim">Holds slices, so it cannot be deleted.</span>
        )}
      </div>
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
        <textarea className="km-textarea" rows={4} value={goal} placeholder="Markdown. What is true when this milestone is done?"
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
  const next = milestones.filter((m) => m.status === 'planned').slice(0, 3);
  const live = cur ? slices.filter((s) => s.milestoneId === cur.id && !s.archived) : [];
  const built = live.reduce((n, s) => n + sliceStateOf(s.id, items).built, 0);
  const total = live.reduce((n, s) => n + sliceStateOf(s.id, items).total, 0);
  return (
    <aside className="ms-aside" aria-label="Milestones">
      <span className="sp-eyebrow">Milestone</span>
      {cur ? <>
        <a className="ms-name" href={hrefTo.detail(slug, 'milestones')}>{cur.name}</a>
        {cur.goal.trim() && <span className="ms-asidegoal">{cur.goal.trim().split('\n')[0]}</span>}
        <span className="sp-dim">{live.length} slice{live.length === 1 ? '' : 's'} · {built}/{total} built{cur.targetOn ? ` · by ${cur.targetOn}` : ''}</span>
      </> : <span className="sp-empty">None current.</span>}
      {next.length > 0 && <>
        <span className="sp-eyebrow">Upcoming</span>
        {next.map((m) => <span key={m.id} className="ms-asidenext">{m.name}</span>)}
      </>}
      <a className="k-btn sm secondary" href={hrefTo.detail(slug, 'milestones')}>All milestones</a>
    </aside>
  );
}
