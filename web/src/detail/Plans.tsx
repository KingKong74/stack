// Read-only planning views follow project → milestone → slice → item.
// Milestone targets are dates, not duration estimates. Unscheduled work stays
// visible in the timeline; the calendar only draws observed schedules/targets.
import { useMemo, useState } from 'react';
import type { Milestone, RoadmapItem, Slice } from '../types';
import { dateAt, fmtDate, isBoardWork, isBuilt, listKeyOf } from '../lib/plan';
import { priorityMeta } from '../lib/ui';

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const scheduleDay = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const statusLabel = (it: RoadmapItem) => ({ planned: 'To do', progress: 'In progress', review: 'In review', shipped: 'Done' }[listKeyOf(it)] || 'Custom column');

export function Plans({ items, milestones, slices, weekZero, onBoard }: {
  slug: string; items: RoadmapItem[]; milestones: Milestone[]; slices: Slice[];
  weekZero: string | null; onBoard?: () => void;
}) {
  const [sub, setSub] = useState<'timeline' | 'calendar'>('timeline');
  const [query, setQuery] = useState('');
  const [hideBuilt, setHideBuilt] = useState(false);
  const [shut, setShut] = useState<string[]>([]);
  const [off, setOff] = useState(0);
  const rows = items.filter((it) => !it.archived && isBoardWork(it));
  const ordered = [...milestones].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.position - b.position || a.id - b.id);
  const groups = ordered.flatMap((m) => [...slices].filter((s) => s.milestoneId === m.id)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((s) => ({ key: `slice-${s.id}`, title: `${m.name} / ${s.title}`, status: `${m.status === 'active' ? 'Current milestone' : m.status === 'done' ? 'Completed milestone' : 'Upcoming milestone'}${s.archived ? ' · Archived slice' : ''}`,
      rows: rows.filter((it) => it.sliceId === s.id).sort((a, b) => a.sliceRank - b.sliceRank) })));
  const unsliced = rows.filter((it) => !slices.some((s) => s.id === it.sliceId));
  if (unsliced.length) groups.push({ key: 'unsliced', title: 'No slice', status: 'Work already in progress', rows: unsliced });
  const matches = (it: RoadmapItem) => (!hideBuilt || !isBuilt(it)) &&
    `${it.id} ${it.title} ${it.area}`.toLowerCase().includes(query.trim().toLowerCase());
  const now = new Date();
  const anchor = new Date(now.getFullYear(), now.getMonth() + off, 1);
  const month = anchor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const cells = useMemo(() => {
    const first = new Date(anchor); first.setDate(1 - (first.getDay() + 6) % 7);
    const count = Math.ceil(((anchor.getDay() + 6) % 7 + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length: count }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); return d; });
  }, [anchor.getFullYear(), anchor.getMonth()]);
  const scheduled = rows.filter((it) => it.sched && weekZero);
  return <div className="pl-screen">
    <div className="pl-tabs k-tabs">
      {(['timeline', 'calendar'] as const).map((t) => <button key={t} className={`k-tab${sub === t ? ' on' : ''}`} onClick={() => setSub(t)}>{t === 'timeline' ? 'Timeline' : 'Calendar'}</button>)}
    </div>
    <div className="pl-view">
      <div className="pl-viewbar">
        <span className="pl-saved">Milestones → slices → work items</span>
        {onBoard && <button className="k-btn sm secondary" onClick={onBoard}>Open board</button>}
      </div>
      {sub === 'timeline' ? <>
        <div className="pl-toolbar">
          <input className="k-input" aria-label="Search plan" placeholder="Search work items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={`k-btn sm secondary${hideBuilt ? ' on' : ''}`} aria-pressed={hideBuilt} onClick={() => setHideBuilt(!hideBuilt)}>{hideBuilt ? 'Show built' : 'Hide built'}</button>
        </div>
        <p className="km-menunote">Planning follows live slices in the current milestone. Only Ready items enter the build queue. Icebox items stay outside the plan.</p>
        <div className="pl-timeline">
          {groups.map((g) => {
            const shown = g.rows.filter(matches); const closed = shut.includes(g.key);
            if (query.trim() && !shown.length) return null;
            return <section className="pl-tlgroup" key={g.key}>
              <button className={`pl-grouphead${closed ? ' shut' : ''}`} aria-expanded={!closed}
                onClick={() => setShut(closed ? shut.filter((k) => k !== g.key) : [...shut, g.key])}>
                <span className="nm">{closed ? '▸' : '▾'} {g.title}</span>
                <span className="k-tag">{g.status}</span><span className="k-tag">{shown.length} items</span>
              </button>
              {!closed && <div className="bl-list">
                <div className="bl-row bl-head"><span>#</span><span>Work item</span><span>Area</span><span>Status</span><span className="bl-c-pri">Pri</span><span className="bl-c-pts">Pts</span><span className="bl-c-spine">Build queue</span><span className="bl-c-when">Start</span><span className="bl-c-when">End</span></div>
                {shown.map((it) => <div className="bl-row" key={it.id}>
                  <span className="bl-id">#{it.id}</span><span className="bl-title"><span className="t">{it.title}</span></span>
                  <span className="k-tag">{it.area || 'no area'}</span><span className="k-tag">{statusLabel(it)}</span>
                  <span className="bl-c-pri" title={priorityMeta(it.bucket).label}>{priorityMeta(it.bucket).glyph}</span>
                  <span className="bl-c-pts">{it.points ?? ''}</span>
                  <span className="bl-c-spine">{it.ready ? `Ready #${it.readyRank + 1}` : 'Not queued'}</span>
                  <span className="bl-c-when">{it.sched && weekZero ? fmtDate(dateAt(it.sched.start, weekZero)!) : '—'}</span>
                  <span className="bl-c-when">{it.sched && weekZero ? fmtDate(dateAt(it.sched.start + it.sched.len, weekZero)!) : '—'}</span>
                </div>)}
                {!shown.length && <div className="km-colempty">No matching work items.</div>}
              </div>}
            </section>;
          })}
          {!groups.length && <div className="km-colempty">No slices yet. Shape the milestone and its slices on the board.</div>}
        </div>
      </> : <>
        <div className="pl-viewbar">
          <span className="pl-saved">Milestone targets and scheduled work · {rows.length - scheduled.length} unscheduled items</span>
          <span className="pl-month">
            <button className="k-btn sm ghost" aria-label="Previous month" onClick={() => setOff(off - 1)}>‹</button>
            <span>{month}</span>
            <button className="k-btn sm ghost" aria-label="Next month" onClick={() => setOff(off + 1)}>›</button>
            <button className="k-btn sm secondary" onClick={() => setOff(0)}>Today</button>
          </span>
        </div>
        <div className="pl-cal">
          <div className="pl-caldays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}</div>
          <div className="pl-calgrid">{cells.map((d) => {
            const key = dayKey(d);
            return <div className={`pl-calcell${d.getMonth() !== anchor.getMonth() ? ' out' : ''}`} key={key}>
              <span className={`d${key === dayKey(now) ? ' today' : ''}`}>{d.getDate()}</span>
              {ordered.filter((m) => m.targetOn === key).map((m) => <div className="pl-calev" key={`m${m.id}`} title={`${m.name} · Target date`}><span className="t">Target: {m.name}</span></div>)}
              {scheduled.filter((it) => {
                const start = dateAt(it.sched!.start, weekZero); const end = dateAt(it.sched!.start + it.sched!.len, weekZero);
                return start && end && key >= scheduleDay(start) && key <= scheduleDay(end);
              }).map((it) => <div className="pl-calev" key={it.id} title={it.title}><span className="id">#{it.id}</span><span className="t">{it.title}</span></div>)}
            </div>;
          })}</div>
        </div>
        <div className="pl-calundated"><span className="lbl">Milestones without a target date: </span>{ordered.filter((m) => !m.targetOn).map((m) => <span className="k-tag" key={m.id}>{m.name}</span>)}</div>
      </>}
    </div>
  </div>;
}
