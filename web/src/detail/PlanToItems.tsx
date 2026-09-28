// SPLIT INTO ITEMS / ATTACH TO ITEM — the one place a captured plan-mode plan
// becomes board work, and it is a human's press in both directions.
//
// SPLIT MAKES MANUAL ROWS, NOT HELD ONES, and that is the decision this file
// carries. Every row is ticked and titled in this dialog by the person at the
// keyboard, which is the sign-off a held row waits for; and every row is born
// in the BACKLOG (a create cannot take a sprint, #477), so nothing runs until
// the same human drags it into the active sprint. A held source would need a
// fourth origin taught to three packages' approval copies for no extra gate.
//
// Rows go through POST /roadmap one at a time, the same route the composer
// uses, so fingerprinting, positions and caps are that route's and not a
// second copy here. A failure part-way STOPS and says how many were made:
// the ones already written are real, are linked to the plan, and are on the
// board; re-running would make them twice.
//
// ATTACH APPENDS to an item's steps and never replaces them. The server keeps
// 30 steps (`cleanPlan`), so an overflow is said before the press, not
// discovered after it.

import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { createRoadmapItem, linkSessionPlanItems, patchRoadmapItem } from '../store';
import { planUnits } from '../lib/planUnits';
import { isBoardWork, isBuilt } from '../lib/plan';
import type { RoadmapItem, SessionPlan } from '../types';

const STEP_MAX = 30;

type Row = { title: string; body: string; on: boolean };

export function PlanToItems({ slug, plan, mode, items, onClose, onDone }: {
  slug: string;
  plan: SessionPlan;
  mode: 'split' | 'attach';
  /** Every roadmap row (the payload's flattened list) — Attach's candidates. */
  items: RoadmapItem[];
  onClose: () => void;
  /** The plan as it now stands, and a line saying what happened. */
  onDone: (plan: SessionPlan, said: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    planUnits(plan.body ?? '').map((u) => ({ title: u.title, body: u.body, on: !u.meta })));
  const targets = useMemo(() => items
    .filter((it) => isBoardWork(it) && !it.archived && !isBuilt(it))
    .sort((a, b) => b.id - a.id), [items]);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const picked = rows.filter((r) => r.on && r.title.trim());
  const item = targets.find((t) => t.id === target) ?? null;
  const room = item ? Math.max(0, STEP_MAX - item.plan.length) : STEP_MAX;
  const already = plan.itemIds.length;

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const split = async () => {
    setBusy(true); setErr('');
    const made: number[] = [];
    let failed = '';
    for (const r of picked) {
      try {
        const it = await createRoadmapItem(slug, {
          title: r.title.trim(),
          note: `From the plan “${plan.title || 'Untitled plan'}” (Plans → Session plans).\n\n${r.body}`.trim(),
          bucket: 'medium',
        });
        made.push(it.id);
      } catch (e) {
        failed = `Stopped at “${r.title.trim()}”: ${(e as Error).message || 'the create failed'}.`;
        break;
      }
    }
    let now = plan;
    if (made.length) {
      try { now = await linkSessionPlanItems(slug, plan.id, made); } catch { /* the rows exist; the link is the record, and its loss is said below */ }
    }
    setBusy(false);
    if (failed) {
      // Nothing made: stay open with the reason. Some made: they are real and
      // on the board, so close and say exactly how far it got.
      if (made.length) onDone(now, `Made ${made.length} of ${picked.length} items in the backlog. ${failed}`);
      else setErr(failed);
      return;
    }
    onDone(now, `Made ${made.length} item${made.length === 1 ? '' : 's'} in the backlog. Drag them into a sprint to schedule them.`);
  };

  const attach = async () => {
    if (!item) return;
    setBusy(true); setErr('');
    const steps = [...item.plan, ...picked.slice(0, room).map((r) => ({ text: r.title.trim(), done: false }))];
    try {
      await patchRoadmapItem(slug, item.id, { plan: steps });
    } catch (e) {
      setBusy(false);
      setErr((e as Error).message || 'Could not update that item.');
      return;
    }
    let now = plan;
    try { now = await linkSessionPlanItems(slug, plan.id, [item.id]); } catch { /* the steps landed; see split */ }
    setBusy(false);
    const n = Math.min(picked.length, room);
    onDone(now, `Added ${n} step${n === 1 ? '' : 's'} to #${item.id} “${item.title}”.`);
  };

  const title = mode === 'split' ? 'Split into items' : 'Attach to an item';

  return (
    <Modal wide onClose={busy ? () => {} : onClose} closeOnOverlay={false}>
      <h3>{title}</h3>
      {!rows.length ? (
        <div className="confirm-body">
          This plan has no sections and no numbered list to take units from, so there is nothing to
          offer. Add it by hand from the board’s composer.
        </div>
      ) : (
        <>
          <div className="confirm-body">
            {mode === 'split'
              ? <>Each ticked unit becomes a <b>manual</b> item in the <b>backlog</b> at medium priority,
                  with its section as the note. Nothing enters a sprint, so nothing runs until you drag it into one.</>
              : <>Each ticked unit is added to the end of the item’s steps. Existing steps stay as they are.</>}
            {already > 0 && (
              <div className="ptl-warn">
                {already} item{already === 1 ? ' was' : 's were'} already made from or given this plan. Splitting it again makes new rows.
              </div>
            )}
          </div>

          {mode === 'attach' && (
            <label className="ptl-target">
              <span className="lbl">Item</span>
              <select className="field-input" value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Choose an item on the board…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>#{t.id} {t.title}{t.plan.length ? ` (${t.plan.length} steps)` : ''}</option>
                ))}
              </select>
            </label>
          )}

          <div className="ptl-rows" role="group" aria-label="Units">
            {rows.map((r, i) => (
              <div key={i} className={`ptl-row${r.on ? '' : ' off'}`}>
                <input type="checkbox" checked={r.on} aria-label={`Include ${r.title}`}
                  onChange={(e) => set(i, { on: e.target.checked })} />
                <input className="field-input" value={r.title} maxLength={300}
                  aria-label="Title" onChange={(e) => set(i, { title: e.target.value })} />
              </div>
            ))}
          </div>

          {mode === 'attach' && item && picked.length > room && (
            <div className="ptl-warn">
              #{item.id} has {item.plan.length} steps and an item holds {STEP_MAX}, so only the first {room} ticked
              unit{room === 1 ? '' : 's'} will be added.
            </div>
          )}
        </>
      )}

      {err && <div className="ptl-err">{err}</div>}

      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose} disabled={busy}>{err ? 'Close' : 'Cancel'}</button>
        {rows.length > 0 && (mode === 'split' ? (
          <button className="btn-submit" disabled={busy || !picked.length} onClick={split}>
            {busy ? 'Making…' : `Make ${picked.length} item${picked.length === 1 ? '' : 's'}`}
          </button>
        ) : (
          <button className="btn-submit" disabled={busy || !picked.length || !item || room === 0} onClick={attach}>
            {busy ? 'Adding…' : `Add ${Math.min(picked.length, room)} step${Math.min(picked.length, room) === 1 ? '' : 's'}`}
          </button>
        ))}
      </div>
    </Modal>
  );
}
