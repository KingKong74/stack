// THE BACKLOG TAB (the Board Map design's Backlog, 2026-11-21): everything
// tracked but not started, in three sections: the Ready queue, the backlog and
// Parked. A details panel on the right edits the selected row.
//
// DECISIONS THE CODE DEPENDS ON:
//  1. THIS FILE WRITES NOTHING ITSELF. Every gesture is one of Board.tsx's
//     writes (`actions`), so a write keeps its receipt and its error line.
//  2. ONLY THE READY QUEUE HAS A RANK THE OWNER SETS. `ready_rank` is the one
//     cross-slice order the schema holds; the backlog section is drawn in run
//     order (`queueOrder`: slice order, `sliceRank`, then bucket) or by
//     priority, and a drop inside it reorders nothing. Inventing a backlog rank
//     here would be a second truth the runner never reads.
//  3. READY REFUSES HERE BEFORE THE SERVER DOES. A held row (`isHeld`) or one in
//     no slice (`roadmap_ready_needs_slice`) cannot be queued; the drop says
//     why rather than sending a write that 4xxs.
//  4. PARKED IS `skipped`. Parking a queued row takes it out of Ready too,
//     because a parked row is one the runner must not pick.
//  5. IN FLIGHT IS NOT HERE. A claimed or built row is on the Board, and the
//     header counts it so it never reads as lost. Auto-ideas live on
//     Propositions and are counted the same way.

import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import type { Milestone, Priority, RoadmapItem, Slice } from '../types';
import { homeOf, isBuilt, queueOrder, bucketRank } from '../lib/plan';
import { isHeld } from '../lib/approval';
import { PRIORITY_META, priorityMeta } from '../lib/ui';
import { currentMilestone } from './Spine';

type Sec = 'queue' | 'backlog' | 'parked';
type Patch = { bucket?: Priority; points?: number | null; sliceId?: number | null; skipped?: boolean; reviewed?: boolean };

export interface BacklogActions {
  /** Replace the whole Ready queue with these ids, in order. */
  setQueue: (ids: number[], note: string) => Promise<void>;
  patch: (it: RoadmapItem, patch: Patch) => Promise<void>;
  run: (it: RoadmapItem) => void;
  edit: (it: RoadmapItem) => void;
  showOnMap: (it: RoadmapItem) => void;
  say: (msg: string) => void;
}

const SIZES: (number | null)[] = [1, 2, 3, 5, 8, 13, null];
const KIND: Record<string, string> = { task: 'Task', story: 'Story', '': 'Item' };
const META: Record<Sec, { title: string; caption: string; empty: string }> = {
  queue: { title: 'Ready queue', caption: 'Builds take from the top.', empty: 'Drag items here to queue them.' },
  backlog: { title: 'Backlog', caption: 'Not queued yet.', empty: 'Nothing waiting.' },
  parked: { title: 'Parked', caption: 'Kept, but not to be picked up.', empty: 'Nothing parked.' },
};
const ICEBOX = 'icebox';

export function BacklogView({ rows, slices, milestones, actions }: {
  rows: RoadmapItem[]; slices: Slice[]; milestones: Milestone[]; actions: BacklogActions;
}) {
  const [filter, setFilter] = useState<string>('all');
  const [sort, setSort] = useState<'run' | 'priority'>('run');
  const [closed, setClosed] = useState<Record<Sec, boolean>>({ queue: false, backlog: false, parked: true });
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [side, setSide] = useState(true);

  const cur = currentMilestone(milestones);
  const planning = useMemo(() => slices.filter((s) => !s.archived && s.milestoneId === cur?.id)
    .sort((a, b) => a.position - b.position || a.id - b.id), [slices, cur]);
  const planningIds = useMemo(() => planning.map((s) => s.id), [planning]);
  const sliceOf = (it: RoadmapItem) => (it.sliceId === null ? undefined : slices.find((s) => s.id === it.sliceId));
  const msName = (s?: Slice) => milestones.find((m) => m.id === s?.milestoneId)?.name || '';

  const live = rows.filter((it) => !it.archived && !it.done);
  const started = (it: RoadmapItem) => it.claimedBy.trim() !== '' || isBuilt(it);
  const pool = live.filter((it) => !started(it) && homeOf(it) !== 'auto');
  const inFlight = live.filter(started).length;
  const ideas = live.filter((it) => homeOf(it) === 'auto' && !started(it)).length;

  const secOf = (it: RoadmapItem): Sec => (it.ready ? 'queue' : it.skipped ? 'parked' : 'backlog');
  const order = queueOrder(planningIds);
  const by: Record<Sec, RoadmapItem[]> = {
    queue: pool.filter((it) => secOf(it) === 'queue').sort((a, b) => a.readyRank - b.readyRank),
    backlog: pool.filter((it) => secOf(it) === 'backlog').sort((a, b) =>
      sort === 'priority' ? bucketRank(a.bucket) - bucketRank(b.bucket) || order(a, b) : order(a, b)),
    parked: pool.filter((it) => secOf(it) === 'parked').sort(order),
  };
  const rankOf = new Map<number, number>();
  [...by.queue, ...by.backlog].forEach((it, i) => rankOf.set(it.id, i + 1));

  const filterKey = (it: RoadmapItem) => (sliceOf(it) ? `s${it.sliceId}` : ICEBOX);
  const pass = (it: RoadmapItem) => filter === 'all' || filterKey(it) === filter;
  const chips = (() => {
    const keys: { key: string; label: string }[] = [];
    for (const s of [...planning, ...slices.filter((x) => !planningIds.includes(x.id))]) {
      if (pool.some((it) => it.sliceId === s.id)) keys.push({ key: `s${s.id}`, label: s.title });
    }
    if (pool.some((it) => !sliceOf(it))) keys.push({ key: ICEBOX, label: 'Icebox' });
    return keys;
  })();

  const queueIds = by.queue.map((it) => it.id);
  const refuse = (it: RoadmapItem): string =>
    isHeld(it) ? `#${it.id} is held: sign it off before it can be queued.`
      : !sliceOf(it) ? `#${it.id} is in the Icebox: give it a slice before it can be queued.` : '';

  // Decision 3 and 4: every section change is one or two of Board's writes.
  const moveTo = async (it: RoadmapItem, to: Sec, before: number | null = null) => {
    const from = secOf(it);
    if (to === 'queue') {
      const why = refuse(it);
      if (why) { actions.say(why); return; }
      if (it.skipped) await actions.patch(it, { skipped: false });
      const ids = queueIds.filter((id) => id !== it.id);
      const at = before === null ? ids.length : Math.max(0, ids.indexOf(before));
      ids.splice(at, 0, it.id);
      await actions.setQueue(ids, from === 'queue' ? `#${it.id} is now number ${at + 1} in the Ready queue.`
        : `#${it.id} is queued to build, number ${at + 1} in the queue.`);
      return;
    }
    if (from === 'queue') await actions.setQueue(queueIds.filter((id) => id !== it.id),
      to === 'parked' ? `#${it.id} left the Ready queue and is parked.` : `#${it.id} left the Ready queue.`);
    if (to === 'parked' && !it.skipped) await actions.patch(it, { skipped: true });
    if (to === 'backlog' && it.skipped) await actions.patch(it, { skipped: false });
  };

  const dropOn = (to: Sec, before: number | null) => (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    const it = pool.find((x) => x.id === drag);
    setDrag(null); setOver(null);
    if (!it || it.id === before) return;
    if (to !== 'queue' && secOf(it) === to) return;   // decision 2: no rank to write
    void moveTo(it, to, before);
  };
  const hover = (key: string) => (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); if (over !== key) setOver(key); };

  const picked = pool.find((it) => it.id === sel) || by.queue[0] || by.backlog[0] || by.parked[0] || null;
  const points = (list: RoadmapItem[]) => {
    const sized = list.filter((it) => it.points !== null);
    const sum = sized.reduce((n, it) => n + (it.points || 0), 0);
    return sized.length === list.length ? `${sum} pts` : `${sum} pts · ${list.length - sized.length} unsized`;
  };

  return (
    <div className={`bl-view${side ? '' : ' side-closed'}`}>
      <div className="bl-main">
        <div className="bl-head">
          <div className="bl-headtext">
            <h2>Backlog</h2>
            <span className="d">
              Everything tracked but not started. Drag into the Ready queue to queue it, and drag inside the queue to
              rank it; builds take from the top.
              {inFlight > 0 && ` ${inFlight} item${inFlight === 1 ? ' is' : 's are'} in flight on the Board.`}
              {ideas > 0 && ` ${ideas} auto-idea${ideas === 1 ? ' waits' : 's wait'} on Propositions.`}
            </span>
          </div>
          <button className="k-btn sm secondary" onClick={() => setSort(sort === 'run' ? 'priority' : 'run')}
            title="The backlog section has no rank of its own. Run order is slice order, then the slice's own order.">
            {sort === 'run' ? 'Sort backlog by priority' : 'Sort backlog by run order'}
          </button>
        </div>

        <div className="bl-chips">
          {[{ key: 'all', label: 'All' }, ...chips].map((c) => (
            <button key={c.key} className={`bl-chip${filter === c.key ? ' on' : ''}`} onClick={() => setFilter(c.key)}>
              {c.label}
              <span className="n">{c.key === 'all' ? pool.length : pool.filter((it) => filterKey(it) === c.key).length}</span>
            </button>
          ))}
        </div>

        <div className="bl-cols bl-grid" aria-hidden>
          <span /><span>#</span><span>Item</span><span /><span className="c-under">Sits under</span>
          <span className="c-prio">Priority</span><span className="c-size">Size</span><span className="c-st">Status</span>
        </div>

        {(['queue', 'backlog', 'parked'] as Sec[]).map((k) => {
          const list = by[k].filter(pass);
          const open = !closed[k];
          return (
            <section className={`bl-sec sec-${k}`} key={k}>
              <button className={`bl-sechead${over === `sec:${k}` ? ' over' : ''}`}
                onDragOver={hover(`sec:${k}`)} onDrop={dropOn(k, null)}
                onClick={() => setClosed({ ...closed, [k]: open })} aria-expanded={open}>
                <span className="chev">{open ? '▾' : '▸'}</span>
                <span className="dot" />
                <span className="t">{META[k].title}</span>
                <span className="n">{list.length}</span>
                <span className="cap">{META[k].caption}</span>
                <span className="pts">{points(list)}</span>
              </button>
              {open && (
                <div className={`bl-zone${over === `sec:${k}` ? ' over' : ''}`}
                  onDragOver={hover(`sec:${k}`)} onDrop={dropOn(k, null)}>
                  {list.map((it) => {
                    const s = sliceOf(it);
                    const pm = priorityMeta(it.bucket);
                    const flag = isHeld(it) ? 'Held' : !s ? 'No slice' : '';
                    return (
                      <div key={it.id} data-hl={it.id} draggable
                        className={`bl-row bl-grid${picked?.id === it.id ? ' on' : ''}${over === `row:${it.id}` ? ' drop' : ''}${drag === it.id ? ' dragging' : ''}`}
                        onDragStart={(e) => { setDrag(it.id); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.id)); } catch { /* old engines */ } }}
                        onDragOver={hover(`row:${it.id}`)}
                        onDrop={dropOn(k, k === 'queue' ? it.id : null)}
                        onDragEnd={() => { setDrag(null); setOver(null); }}
                        onClick={() => setSel(it.id)}
                        onDoubleClick={() => actions.edit(it)}>
                        <span className="grip" aria-hidden>⋮⋮</span>
                        <span className="rank">{rankOf.get(it.id) ?? '—'}</span>
                        <span className="ref"><span className="kind">{KIND[it.kind] || 'Item'}</span><span className="id">#{it.id}</span></span>
                        <span className="ttl">
                          <span className="t">{it.title}</span>
                          {flag && <span className={`k-tag${flag === 'Held' ? ' warning' : ''}`}>{flag}</span>}
                        </span>
                        <span className="c-under under" title={s ? `${msName(s)} / ${s.title}` : 'Icebox'}>{s ? s.title : 'Icebox'}</span>
                        <button className="c-prio prio" title="Click to change priority"
                          onClick={(e) => {
                            e.stopPropagation(); setSel(it.id);
                            const i = PRIORITY_META.findIndex((p) => p.key === pm.key);
                            void actions.patch(it, { bucket: PRIORITY_META[(i + 1) % PRIORITY_META.length].key });
                          }}>
                          <span className="sw" style={{ background: pm.color }} />{pm.label}
                        </button>
                        <span className="c-size pts">{it.points ?? '—'}</span>
                        <span className={`c-st k-tag${k === 'queue' ? ' info' : ''}`}>
                          {k === 'queue' ? 'Queued' : k === 'parked' ? 'Parked' : 'To do'}
                        </span>
                      </div>
                    );
                  })}
                  {list.length === 0 && <span className="bl-empty">{META[k].empty}</span>}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <aside className="bl-side">
        {!side ? (
          <button className="bl-sideopen" onClick={() => setSide(true)} title="Expand">
            <span>«</span><span className="v">{picked ? `#${picked.id}` : 'Details'}</span>
          </button>
        ) : (
          <>
            <button className="bl-sidex" onClick={() => setSide(false)} title="Collapse">»</button>
            {!picked ? <div className="bl-sidesec"><span className="bl-empty">Nothing tracked and unstarted.</span></div> : (
              <Details it={picked} sec={secOf(picked)} rank={rankOf.get(picked.id)} queuePos={queueIds.indexOf(picked.id)} firstQueued={queueIds[0] ?? null}
                slice={sliceOf(picked)} msName={msName(sliceOf(picked))} places={planning}
                refuse={refuse(picked)} actions={actions} moveTo={moveTo} />
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function Details({ it, sec, rank, queuePos, firstQueued, slice, msName, places, refuse, actions, moveTo }: {
  it: RoadmapItem; sec: Sec; rank: number | undefined; queuePos: number; firstQueued: number | null;
  slice: Slice | undefined; msName: string;
  places: Slice[]; refuse: string; actions: BacklogActions;
  moveTo: (it: RoadmapItem, to: Sec, before?: number | null) => Promise<void>;
}) {
  const pm = priorityMeta(it.bucket);
  const opts: { id: number | null; ref: string; title: string }[] = [
    ...places.map((s) => ({ id: s.id as number | null, ref: '', title: s.title })),
    ...(slice && !places.some((s) => s.id === slice.id) ? [{ id: slice.id, ref: '·', title: `${msName} / ${slice.title}` }] : []),
    { id: null, ref: '—', title: 'Icebox (no slice)' },
  ];
  const note = isHeld(it) ? 'Held: the runner will not take it until you sign it off.'
    : !slice ? 'In the Icebox: off the Board and out of progress. Give it a slice to queue it.'
      : sec === 'queue' ? `Position ${queuePos + 1} in the Ready queue.`
        : sec === 'parked' ? 'Parked rows keep their slice; nothing picks them up.'
          : 'Double-click any row to open the full editor.';
  return (
    <>
      <div className="bl-sidesec">
        <div className="bl-sidetop">
          <span className="kind">{KIND[it.kind] || 'Item'}</span>
          <span className="id">#{it.id}</span>
          <span className="sp" />
          <span className="rk">{sec === 'parked' ? 'Parked' : rank ? `Rank ${rank}` : ''}</span>
        </div>
        <h2 className="bl-sidettl">{it.title}</h2>
        <span className="bl-sideunder">{slice ? `${msName} / ${slice.title}` : 'Icebox'}</span>
      </div>
      <div className="bl-sidesec">
        <div className="bl-field">
          <span className="lbl">Priority</span>
          <div className="bl-seg">
            {PRIORITY_META.map((p) => (
              <button key={p.key} className={p.key === pm.key ? 'on' : ''} title={p.label}
                onClick={() => { if (p.key !== pm.key) void actions.patch(it, { bucket: p.key }); }}>
                <span className="sw" style={{ background: p.color }} />
                {p.key === 'highest' ? 'Top' : p.key === 'lowest' ? 'Least' : p.key === 'medium' ? 'Med' : p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="bl-field">
          <span className="lbl">Size · points</span>
          <div className="bl-sizes">
            {SIZES.map((v) => (
              <button key={String(v)} className={it.points === v ? 'on' : ''}
                onClick={() => { if (it.points !== v) void actions.patch(it, { points: v }); }}>{v ?? '—'}</button>
            ))}
          </div>
        </div>
        <div className="bl-field">
          <span className="lbl">Sits under</span>
          <div className="bl-places">
            {opts.map((o) => (
              <button key={String(o.id)} className={it.sliceId === o.id ? 'on' : ''}
                onClick={() => { if (it.sliceId !== o.id) void actions.patch(it, { sliceId: o.id }); }}>
                {o.ref && <span className="ref">{o.ref}</span>}<span className="t">{o.title}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="bl-sidesec bl-acts">
        {isHeld(it) && <button className="k-btn" onClick={() => void actions.patch(it, { reviewed: true })}>Sign off</button>}
        <button className={`k-btn${sec === 'queue' || isHeld(it) ? ' secondary' : ''}`} disabled={sec !== 'queue' && !!refuse}
          title={sec !== 'queue' ? refuse : undefined}
          onClick={() => void moveTo(it, sec === 'queue' ? 'backlog' : 'queue')}>
          {sec === 'queue' ? 'Remove from Ready queue' : 'Add to Ready queue'}
        </button>
        <div className="row">
          {sec === 'queue' && (
            <button className="k-btn secondary" disabled={queuePos === 0 || firstQueued === null}
              onClick={() => void moveTo(it, 'queue', firstQueued)}>Move to top</button>
          )}
          <button className="k-btn secondary" onClick={() => void moveTo(it, sec === 'parked' ? 'backlog' : 'parked')}>
            {sec === 'parked' ? 'Unpark' : 'Park'}
          </button>
        </div>
        <div className="row">
          <button className="k-btn ghost" onClick={() => actions.showOnMap(it)} disabled={!slice}
            title={slice ? undefined : 'The Icebox is off the map.'}>Show on map</button>
          <button className="k-btn ghost" onClick={() => actions.run(it)}
            title="Claims the item and opens a Claude session on it in the terminal.">Run in terminal</button>
        </div>
        <button className="k-btn ghost" onClick={() => actions.edit(it)}>Edit item…</button>
        <span className="bl-note">{note}</span>
      </div>
    </>
  );
}
