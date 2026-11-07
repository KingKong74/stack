// THE SPINE'S CONTROLS (#608): the milestone strip over the board, the slice
// and milestone dialogs, and the Icebox list For you draws beside Auto-ideas.
//
// project → milestone → slice → item, and an item in no slice is in the
// ICEBOX. `homeOf` in lib/plan.ts decides which screen a row is on; nothing
// here re-derives it. A slice's state is `sliceStateOf`, derived and never
// stored. The server's rules (routes/spine.js) are the ones these controls
// SAY out loud rather than pre-empt:
//
//  • Making a milestone current FINISHES the one before it, in the same write.
//  • A milestone with slices cannot be deleted, so there is no delete here.
//  • Deleting a slice sends its items to the Icebox and takes them out of
//    Ready. The second press says both, because neither is guessable.
//  • An unsliced item cannot be queued to build (Ready ⇒ sliced is a CHECK).
//
// The board is designed for the owner's hands (web/CLAUDE.md): these are a
// human's tools, and nothing in the automation writes a milestone or a slice.

import { useMemo, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { Milestone, RoadmapItem, Slice } from '../types';
import { isIced } from '../lib/plan';
import { priorityMeta, timeAgo } from '../lib/ui';

/** The milestone everything is filed under right now, or null. */
export const currentMilestone = (ms: Milestone[]): Milestone | null => ms.find((m) => m.status === 'active') ?? null;

/** Slices someone can still file work into: not archived, current milestone first. */
export function liveSlices(slices: Slice[], ms: Milestone[]): Slice[] {
  const cur = currentMilestone(ms)?.id ?? null;
  return slices.filter((s) => !s.archived)
    .sort((a, b) => Number(b.milestoneId === cur) - Number(a.milestoneId === cur));
}

/** A slice's title, with its milestone when that is not the current one. */
export function sliceLabel(s: Slice, ms: Milestone[]): string {
  const m = ms.find((x) => x.id === s.milestoneId);
  return m && m.status !== 'active' ? `${s.title} · ${m.name}` : s.title;
}

/**
 * THE SLICE PICKER, as one native select: every live slice, then the Icebox.
 * `value` null is the Icebox. Used on the card menu, the Icebox rows and
 * Promote, so the three places a row changes slice offer the same list.
 */
export function SlicePicker({ value, slices, milestones, onPick, iceboxLabel = 'Icebox (no slice)', label, disabled }: {
  value: number | null; slices: Slice[]; milestones: Milestone[];
  onPick: (sliceId: number | null) => void; iceboxLabel?: string; label: string; disabled?: boolean;
}) {
  const live = liveSlices(slices, milestones);
  const known = value === null || live.some((s) => s.id === value);
  return (
    <select className="k-select sm km-slicepick" aria-label={label} value={value === null ? '' : String(value)}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onPick(e.target.value === '' ? null : Number(e.target.value))}>
      {/* An archived slice still holds its rows; say which, rather than show a blank. */}
      {!known && <option value={String(value)}>{slices.find((s) => s.id === value)?.title || `Slice ${value}`} (archived)</option>}
      {live.map((s) => <option key={s.id} value={s.id}>{sliceLabel(s, milestones)}</option>)}
      <option value="">{iceboxLabel}</option>
    </select>
  );
}

/**
 * THE STRIP OVER THE BOARD: where this is going, before any card. The current
 * milestone and its goal, how many slices it holds, and how much is waiting in
 * the Icebox. The Icebox count is what explains a low progress number right
 * after the spine landed: most of a board was iced for triage.
 */
export function SpineStrip({ milestones, slices, iced, onMilestone, onNewSlice, onIcebox }: {
  milestones: Milestone[]; slices: Slice[]; iced: number;
  onMilestone: () => void; onNewSlice: () => void; onIcebox: () => void;
}) {
  const cur = currentMilestone(milestones);
  const inCur = cur ? slices.filter((s) => s.milestoneId === cur.id && !s.archived).length : 0;
  return (
    <div className="km-spine">
      <span className="km-spine-eyebrow">Milestone</span>
      <button className="km-spine-ms" onClick={onMilestone}
        title={cur?.goal.trim() || 'Name the milestone and say what it is for'}>
        {cur ? cur.name : 'None current'}
        <KitIcon name="chevron-down" size={12} />
      </button>
      {cur?.goal.trim() && <span className="km-spine-goal">{cur.goal.trim().split('\n')[0]}</span>}
      {cur?.targetOn && <span className="k-tag" title="A target you set. It gates nothing.">by {cur.targetOn}</span>}
      <span className="km-spine-rule" />
      <span className="km-spine-n">{inCur} slice{inCur === 1 ? '' : 's'}</span>
      <button className="k-btn sm secondary" onClick={onNewSlice}
        title="A slice is one shippable piece of the milestone. Cards on the board belong to one.">
        <KitIcon name="plus" size={13} />Slice
      </button>
      <button className={`k-btn sm ${iced ? 'secondary' : 'ghost'}`} onClick={onIcebox}
        title="Kept ideas that belong to no slice yet. They are not on the board, do not count toward progress and cannot be queued to build.">
        Icebox{iced ? ` · ${iced}` : ''}
      </button>
    </div>
  );
}

/** New or edit. `slice` null creates one in the current milestone. */
export function SliceDialog({ slice, milestones, areaNames, count, onClose, onSave, onDelete }: {
  slice: Slice | null; milestones: Milestone[]; areaNames: string[];
  /** Rows in it now, so the delete can say how many go to the Icebox. */
  count: number;
  onClose: () => void;
  onSave: (v: { title: string; spec: string; areas: string[]; milestoneId: number | null }) => void;
  onDelete?: () => void;
}) {
  const cur = currentMilestone(milestones);
  const [title, setTitle] = useState(slice?.title ?? '');
  const [spec, setSpec] = useState(slice?.spec ?? '');
  const [areas, setAreas] = useState<string[]>(slice?.areas ?? []);
  const [mid, setMid] = useState<number | null>(slice?.milestoneId ?? cur?.id ?? null);
  const [confirming, setConfirming] = useState(false);
  // An area the slice names that nothing has registered yet is still offered,
  // so editing a slice never silently drops one of its own.
  const offered = useMemo(() => [...new Set([...areaNames, ...areas])].sort(), [areaNames, areas]);
  const flip = (a: string) => setAreas((xs) => (xs.includes(a) ? xs.filter((x) => x !== a) : [...xs, a]));
  const submit = () => { const t = title.trim(); if (t) onSave({ title: t, spec, areas, milestoneId: mid }); };
  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-dialog km-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="km-dialog-head">
          <span className="t">{slice ? 'Edit slice' : 'New slice'}</span>
          <span className="d">
            One shippable piece of a milestone. Every card on the board belongs to a slice; a kept idea
            with none waits in the Icebox.
          </span>
        </div>
        <label className="km-field">
          <span className="lbl">Title</span>
          <span className="searchbox km-input">
            <input autoFocus placeholder="What ships when this is done" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </span>
        </label>
        <label className="km-field">
          <span className="lbl">Milestone</span>
          <select className="km-select" value={mid === null ? '' : String(mid)}
            onChange={(e) => setMid(e.target.value === '' ? null : Number(e.target.value))}>
            {mid === null && <option value="">Current (made for you if there is none)</option>}
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.status === 'active' ? ' (current)' : m.status === 'done' ? ' (done)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="km-field">
          <span className="lbl">Spec</span>
          <textarea className="km-textarea" rows={6} value={spec}
            placeholder="Markdown. What it is, what done looks like, what is out of scope."
            onChange={(e) => setSpec(e.target.value)} />
        </label>
        {offered.length > 0 && (
          <div className="km-field">
            <span className="lbl">Areas it touches</span>
            <span className="km-areapicks">
              {offered.map((a) => (
                <button key={a} type="button" className={`im-chip${areas.includes(a) ? ' on' : ''}`}
                  aria-pressed={areas.includes(a)} onClick={() => flip(a)}>{a}</button>
              ))}
            </span>
          </div>
        )}
        <div className="km-dialog-foot">
          {slice && onDelete && (
            <button className="k-btn danger km-dialog-left" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
              {confirming
                ? (count ? `Delete? Its ${count} item${count === 1 ? '' : 's'} go to the Icebox and leave Ready` : 'Really delete?')
                : 'Delete slice'}
            </button>
          )}
          <button className="k-btn ghost" onClick={onClose}>Cancel</button>
          <button className="k-btn" onClick={submit} disabled={!title.trim()}>{slice ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The current milestone's name, goal and target, plus the two ways to move on:
 * start a new one, or make an existing one current. Either FINISHES the one in
 * progress, and the line under the buttons says so before the press.
 */
export function MilestoneDialog({ milestones, onClose, onSave, onCreate, onMakeCurrent }: {
  milestones: Milestone[];
  onClose: () => void;
  onSave: (id: number, v: { name: string; goal: string; targetOn: string | null }) => void;
  onCreate: (v: { name: string; goal: string; targetOn: string | null }) => void;
  onMakeCurrent: (id: number) => void;
}) {
  const cur = currentMilestone(milestones);
  const [name, setName] = useState(cur?.name ?? '');
  const [goal, setGoal] = useState(cur?.goal ?? '');
  const [targetOn, setTargetOn] = useState(cur?.targetOn ?? '');
  const [fresh, setFresh] = useState('');
  const others = milestones.filter((m) => m.id !== cur?.id && m.status !== 'done');
  const save = () => {
    const n = name.trim();
    if (!n) return;
    if (cur) onSave(cur.id, { name: n, goal, targetOn: targetOn || null });
    else onCreate({ name: n, goal, targetOn: targetOn || null });
  };
  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-dialog km-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="km-dialog-head">
          <span className="t">{cur ? 'Current milestone' : 'Set a milestone'}</span>
          <span className="d">Where this project is going next. Slices belong to a milestone; the target date gates nothing.</span>
        </div>
        <label className="km-field">
          <span className="lbl">Name</span>
          <span className="searchbox km-input">
            <input autoFocus value={name} placeholder="e.g. Public beta" onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <label className="km-field">
          <span className="lbl">Goal</span>
          <textarea className="km-textarea" rows={4} value={goal}
            placeholder="Markdown. What is true when this milestone is done?"
            onChange={(e) => setGoal(e.target.value)} />
        </label>
        <label className="km-field">
          <span className="lbl">Target</span>
          <input className="km-select" type="date" value={targetOn} aria-label="Target date"
            onChange={(e) => setTargetOn(e.target.value)} />
        </label>
        {cur && (
          <div className="km-field">
            <span className="lbl">Move on</span>
            <span className="km-msnext">
              <span className="searchbox km-input">
                <input value={fresh} placeholder="Next milestone's name" onChange={(e) => setFresh(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && fresh.trim()) onCreate({ name: fresh.trim(), goal: '', targetOn: null }); }} />
              </span>
              <button className="k-btn secondary" disabled={!fresh.trim()}
                onClick={() => onCreate({ name: fresh.trim(), goal: '', targetOn: null })}>Start it</button>
            </span>
            {others.map((m) => (
              <button key={m.id} className="k-btn ghost sm km-dialog-left" onClick={() => onMakeCurrent(m.id)}>
                Make “{m.name}” current
              </button>
            ))}
            <span className="km-menunote">Starting or switching finishes “{cur.name}”. Its slices stay where they are.</span>
          </div>
        )}
        <div className="km-dialog-foot">
          <button className="k-btn ghost" onClick={onClose}>Cancel</button>
          <button className="k-btn" onClick={save} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

/**
 * THE ICEBOX: kept ideas in no slice. It is a screen a row can live on
 * (`homeOf` → 'icebox'), so every row here has two ways out: into a slice
 * (onto the board) or Archive. Delete stays on the board's card menu and the
 * item modal, because a kept idea was already signed off once.
 */
export function IceboxList({ items, slices, milestones, busy, onSlice, onArchive, onEdit }: {
  items: RoadmapItem[]; slices: Slice[]; milestones: Milestone[]; busy: number | null;
  onSlice: (it: RoadmapItem, sliceId: number) => void;
  onArchive: (it: RoadmapItem) => void;
  onEdit: (it: RoadmapItem) => void;
}) {
  const rows = useMemo(() => items
    .filter((it) => !it.archived && isIced(it))
    .sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0) || b.id - a.id),
  [items]);
  const live = liveSlices(slices, milestones);
  return (
    <div className="ai ai-icebox">
      <div className="ai-lede">
        <b>Icebox</b> — kept, but in no slice yet. Nothing here is on the board, counts toward progress or can
        be queued to build. Move a row into a slice when you know where it belongs.
        {live.length === 0 && ' There are no slices yet: make one from the board’s strip.'}
      </div>
      {rows.map((it) => {
        const p = priorityMeta(it.bucket);
        return (
          <div className="ai-row" key={it.id} data-hl={it.id}>
            <span className="ai-ico tone-neutral"><KitIcon name="layers" size={13} /></span>
            <div className="ai-body">
              <div className="ai-top">
                <span className="ai-title">{it.title}</span>
                <span className="ai-when">{timeAgo(it.updatedAt)}</span>
              </div>
              {it.note.trim() && <p className="ai-why clamp">{it.note}</p>}
              <div className="ai-meta">
                <span className="ai-src">#{it.id}</span>
                {it.area.trim() && <span className="k-tag">{it.area}</span>}
                <span className="k-tag" style={{ color: p.color }} title={`Priority — ${p.label}`}>{p.glyph} {p.short}</span>
                <button className="k-btn ghost sm" onClick={() => onEdit(it)}><KitIcon name="pencil" size={13} />Edit…</button>
                <button className="k-btn ghost sm" disabled={busy === it.id} onClick={() => onArchive(it)}>Archive</button>
              </div>
            </div>
            <div className="ai-acts">
              <SlicePicker value={null} slices={slices} milestones={milestones} disabled={busy === it.id || live.length === 0}
                label={`Move #${it.id} into a slice`} iceboxLabel="Move to slice…"
                onPick={(sid) => { if (sid !== null) onSlice(it, sid); }} />
            </div>
          </div>
        );
      })}
      {rows.length === 0 && <span className="im-empty">The Icebox is empty.</span>}
    </div>
  );
}
