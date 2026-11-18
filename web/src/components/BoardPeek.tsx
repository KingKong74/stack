// THE BOARD PEEK — a collapsible drawer on the Terminal screen that shows the
// focused session's project board without leaving the session (owner's
// request, 2026-11-18). ⌃` still flicks to the real board; this is for the
// glance in between.
//
// READ-ONLY, ON PURPOSE (owner's call: "peek + open item"). A row expands in
// place to show its note, plan and built note, and links to itself on the
// board. Nothing here drags, ticks, signs off or gives a verdict, so the board
// stays the one place a row is acted on. `lib/boardPeek.ts` says which rows
// are drawn and in what order.
//
// It renders the Terminal's own project payload (the one the crumb reads), so
// it never fetches by itself; the Terminal re-reads that payload through
// `useAutoRefresh` while the drawer is open.

import { useMemo, useState } from 'react';
import type { ProjectDetailData } from '../store';
import type { RoadmapItem } from '../types';
import { hrefTo } from '../lib/route';
import { peekGroups } from '../lib/boardPeek';
import { isHeld } from '../lib/approval';
import { priorityMeta, timeAgo } from '../lib/ui';
import { FLICK_HINT } from '../lib/flick';

const DONE_SHOWN = 10;

export function BoardPeek({ board, onClose }: { board: ProjectDetailData; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  // Done is history; it starts folded so the glance lands on live work.
  const [folded, setFolded] = useState<Set<string>>(() => new Set(['shipped']));
  const rows = useMemo(() => [
    ...board.roadmap.highest, ...board.roadmap.high, ...board.roadmap.medium,
    ...board.roadmap.low, ...board.roadmap.lowest,
  ], [board.roadmap]);
  const groups = useMemo(
    () => peekGroups(rows, board.milestones, board.slices, q),
    [rows, board.milestones, board.slices, q],
  );
  const sliceName = useMemo(() => new Map(board.slices.map((s) => [s.id, s.title])), [board.slices]);
  const pid = board.project.id;
  const toggleFold = (k: string) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const row = (it: RoadmapItem, parts: RoadmapItem[], part = false) => {
    const on = open === it.id;
    const pri = priorityMeta(it.bucket);
    return (
      <li key={it.id} className={`bp-row${on ? ' on' : ''}${part ? ' part' : ''}`}>
        <button className="bp-head" aria-expanded={on} onClick={() => setOpen(on ? null : it.id)}>
          <span className="bp-id mono">#{it.id}</span>
          <span className="bp-title">{it.title}</span>
          <span className="bp-chips">
            {it.ready && <span className="bp-chip ready" title={`Ready queue, rank ${it.readyRank}`}>ready</span>}
            {isHeld(it) && <span className="bp-chip held" title="Not signed off: the runner won't take it">held</span>}
            {parts.length > 0 && <span className="bp-chip" title={`${parts.length} parts`}>{parts.length} parts</span>}
          </span>
        </button>
        {on && (
          <div className="bp-body">
            <div className="bp-meta">
              <span>{pri.label}</span>
              {it.area && <span>{it.area}</span>}
              {it.sliceId !== null && sliceName.get(it.sliceId) && <span title="Slice">{sliceName.get(it.sliceId)}</span>}
              {it.claimedBy.trim() && <span className="mono" title="Branch claim">⎇ {it.claimedBy}</span>}
              {it.updatedAt && <span>updated {timeAgo(it.updatedAt)}</span>}
            </div>
            {it.note.trim() && <p className="bp-note">{it.note}</p>}
            {it.plan.length > 0 && (
              <ol className="bp-plan">
                {it.plan.map((s, i) => <li key={i} className={s.done ? 'done' : ''}>{s.text}</li>)}
              </ol>
            )}
            {it.builtNote.trim() && (
              <div className="bp-built"><span className="bp-k">Built</span><p>{it.builtNote}</p></div>
            )}
            {it.refineNote.trim() && (
              <div className="bp-built"><span className="bp-k">Sent back</span><p>{it.refineNote}</p></div>
            )}
            {parts.length > 0 && <ul className="bp-parts">{parts.map((p) => row(p, [], true))}</ul>}
            <a className="bp-open" href={hrefTo.detail(pid, 'roadmap', String(it.id))}>Open on the board →</a>
          </div>
        )}
      </li>
    );
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <aside className="board-peek" aria-label={`${board.project.name} board`}>
      <div className="bp-top">
        <a className="bp-name" href={hrefTo.detail(pid, 'roadmap')} title={`Open the board (${FLICK_HINT})`}>{board.project.name}</a>
        <span className="bp-sub">board</span>
        <button className="bp-x" onClick={onClose} title="Close the board peek (⌃⇧`)" aria-label="Close the board peek">×</button>
      </div>
      <input className="bp-q" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by title, #id or area" aria-label="Filter board items" />
      <div className="bp-list">
        {groups.map((g) => {
          const isFolded = folded.has(g.key);
          const shown = g.key === 'shipped' ? g.rows.slice(0, DONE_SHOWN) : g.rows;
          return (
            <section key={g.key} className={`bp-group k-${g.key}`}>
              <button className="bp-gh" aria-expanded={!isFolded} onClick={() => toggleFold(g.key)}>
                <span className="bp-caret" aria-hidden="true">{isFolded ? '▸' : '▾'}</span>
                <span className="bp-gl">{g.label}</span>
                <span className="bp-n mono">{g.rows.length}</span>
              </button>
              {!isFolded && (
                <ul className="bp-rows">
                  {shown.map((r) => row(r.item, r.parts))}
                  {shown.length < g.rows.length && (
                    <li className="bp-more">
                      <a href={hrefTo.detail(pid, 'roadmap')}>{g.rows.length - shown.length} older on the board</a>
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
        {total === 0 && (
          <p className="bp-empty">{q.trim() ? 'Nothing on the board matches.' : 'The board is empty.'}</p>
        )}
      </div>
    </aside>
  );
}
