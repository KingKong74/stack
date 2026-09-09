// THE ROADMAP TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// `ui_kits/console/IdeasScreen.jsx` ported to TS, on the kit's own sample rows
// (MDP-3 … MDP-14). The tab that read `roadmap_items` — the Ready / Thinking /
// Parked columns derived from `tier`, `skipped` and the approval predicate, the
// HELD chip, ✓ Keep, Open, Park and Delete — was removed at the owner's request
// and replaced with this. Board.tsx's header lists what that costs across both
// tabs; the two specific to this one:
//
//  • ✓ KEEP HAS NO SURFACE HERE ANY MORE, and since #444 it has none on For you
//    either — Auto-ideas went with the rest of that screen. A `hook` or `fly`
//    row still sits held out of the overnight runner until someone signs it
//    off, and `./stack` and the API are now the only way to do that.
//  • A HELD ROW NO LONGER APPEARS ON A SHELF ANYWHERE. The first cut of the
//    real screen learned that an item on no screen is a lie of omission; that
//    is the state the app is in until one of these tabs is wired back.
//
// THE AREA SCOPE IS THE KIT'S OWN IDEA AND IT IS NOT `area` AS THIS APP MEANS
// IT. Here it is six labels used to file an idea somewhere other than one flat
// pile. In the database `area` is load-bearing in a way no browser control
// should treat casually: `(project, area)` IS THE LANE (#267), an area with an
// open claimed item admits no second overnight worker, and untagged ('') is
// deliberately never a lane. So "Move area" below is not a filing gesture — a
// real one re-partitions the night's concurrency, and the rule lives in
// `server/src/lanes.js` and its two mirrors. Nothing here can reach it.
//
// "Promote to issue", "Move area" and "Discard" are the kit's own buttons and
// do nothing; the only live state is the scope chip and which card is expanded.

import { useState } from 'react';
import { KitIcon, type KitIconName } from './kit/KitIcon';

type AreaKey = 'global' | 'design' | 'board' | 'plans' | 'quality' | 'print';

const AREAS: { key: AreaKey; name: string; icon: KitIconName; scope: string }[] = [
  { key: 'global', name: 'Global', icon: 'layers', scope: 'Cuts across the whole app' },
  { key: 'design', name: 'Design system', icon: 'bookmark', scope: 'Tokens, components, contrast' },
  { key: 'board', name: 'Board and stack', icon: 'layout-grid', scope: 'Columns, cards, keyboard' },
  { key: 'plans', name: 'Plans and progress', icon: 'list', scope: 'Timeline, calendar, releases' },
  { key: 'quality', name: 'Quality', icon: 'circle-check', scope: 'Checks, verdicts, bugs' },
  { key: 'print', name: 'Print and export', icon: 'file-text', scope: 'Sheets, PDF, hand-off' },
];

type MockIdea = {
  id: string; area: AreaKey; title: string; state: 'Ready' | 'Thinking' | 'Parked';
  effort: string; note: string; from: string; age: string; tags: string[];
};

const IDEAS: MockIdea[] = [
  {
    id: 'MDP-14', area: 'global', title: 'One command palette for everything', state: 'Parked', effort: 'L',
    note: 'Every screen reachable by keystroke. Big, and the shell already covers most of it.',
    from: 'sunday afternoon', age: '2 wk', tags: ['nav'],
  },
  {
    id: 'MDP-13', area: 'global', title: 'Light mode', state: 'Parked', effort: 'L',
    note: 'The palette inverts cleanly on paper, but I never work in daylight.',
    from: 'from the token audit', age: '2 wk', tags: ['theme'],
  },
  {
    id: 'MDP-12', area: 'global', title: 'Session replay on any screen', state: 'Thinking', effort: 'M',
    note: 'Scrub back through what the agent touched, wherever you are. Needs an event log first.',
    from: 'noted mid-session', age: '4d', tags: ['agents'],
  },
  {
    id: 'MDP-6', area: 'design', title: 'Column headers in mono', state: 'Ready', effort: 'S',
    note: 'The sans reads too soft at 13px. Mono at 12 with caps tracking holds the column edge.',
    from: 'while building the board', age: '2h', tags: ['type'],
  },
  {
    id: 'MDP-11', area: 'design', title: 'Second surface step for nested cards', state: 'Thinking', effort: 'S',
    note: 'Cards inside cards need one more step above --surface-card or the hairline does all the work.',
    from: 'from the plans summary', age: '1d', tags: ['surfaces'],
  },
  {
    id: 'MDP-5', area: 'board', title: 'Diff bars on every file row', state: 'Ready', effort: 'S',
    note: 'Add/delete proportion bar next to the counts — cheap, and it reads instantly.',
    from: 'from the working-copy panel', age: '5h', tags: ['viz'],
  },
  {
    id: 'MDP-4', area: 'board', title: 'Virtualise the trail list too', state: 'Thinking', effort: 'M',
    note: 'Same recycling trick as the columns. Only matters past ~400 rows, so probably not yet.',
    from: 'noted during KING-18', age: 'Mon', tags: ['perf'],
  },
  {
    id: 'MDP-3', area: 'plans', title: 'Budget line on the usage chart', state: 'Thinking', effort: 'M',
    note: 'Draw a target on the chart so overspend is visible without doing arithmetic.',
    from: 'after the $493 week', age: 'Mon', tags: ['usage'],
  },
  {
    id: 'MDP-10', area: 'plans', title: 'Drag a bar to move a date', state: 'Ready', effort: 'M',
    note: 'Timeline rows already know their dates. Dragging should write them back.',
    from: 'from the timeline grid', age: '3d', tags: ['timeline'],
  },
  {
    id: 'MDP-9', area: 'quality', title: 'Quarantine flaky checks automatically', state: 'Ready', effort: 'M',
    note: 'Anything red in 3 of 20 runs moves to a quarantine list rather than failing the suite.',
    from: 'from run 4481', age: '1h', tags: ['checks'],
  },
  {
    id: 'MDP-8', area: 'quality', title: 'Verdict reminders after two days', state: 'Thinking', effort: 'S',
    note: 'The oldest moved item sat three days. A nudge is cheaper than a dashboard.',
    from: 'from the verdict panel', age: '2d', tags: ['review'],
  },
  {
    id: 'MDP-7', area: 'print', title: 'Print sheet geometry', state: 'Parked', effort: 'M',
    note: 'Branch is 11 days stale and conflicts with the token split. Rebase or close it.',
    from: 'from the branch sweep', age: '11d', tags: ['print'],
  },
];

const IDEA_COLUMNS: MockIdea['state'][] = ['Ready', 'Thinking', 'Parked'];

export function IdeasMock() {
  const [scope, setScope] = useState<AreaKey | 'all'>('all');
  const [open, setOpen] = useState<string | null>('MDP-6');

  const shown = scope === 'all' ? IDEAS : IDEAS.filter((i) => i.area === scope);
  const sections = scope === 'all' ? AREAS : AREAS.filter((a) => a.key === scope);
  const ready = shown.filter((i) => i.state === 'Ready').length;

  return (
    <div className="im">
      <div className="im-head">
        <div className="im-title">
          <span className="eyebrow">Workspace</span>
          <h1>Roadmap</h1>
        </div>
        <span className="im-lede">{IDEAS.length} ideas · {ready} ready in this scope</span>
      </div>

      {/* The scope: one chip per area, and "All areas" is a scope like any
          other rather than the absence of one. */}
      <div className="im-bar">
        <AreaChip label="All areas" count={IDEAS.length}
          active={scope === 'all'} onClick={() => setScope('all')} />
        <span className="im-chipsep" />
        {AREAS.map((a) => (
          <AreaChip key={a.key} icon={a.icon} label={a.name}
            count={IDEAS.filter((i) => i.area === a.key).length}
            active={scope === a.key} onClick={() => setScope(a.key)} />
        ))}
        <span className="searchbox sm im-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search ideas" aria-label="Search ideas" />
        </span>
        <button className="k-btn sm secondary im-capture">
          <KitIcon name="plus" size={14} />Capture idea
        </button>
      </div>

      <div className="im-sections">
        {sections.map((a) => {
          const items = shown.filter((i) => i.area === a.key);
          if (!items.length) return null;
          return (
            <section className="im-section" key={a.key}>
              <div className="im-sechead">
                <span className={`ico${a.key === 'global' ? ' global' : ''}`}>
                  <KitIcon name={a.icon} size={13} />
                </span>
                <span className="nm">{a.name}</span>
                <span className="scope">{a.scope}</span>
                <span className="n">{items.length} ideas</span>
              </div>

              <div className="im-cols">
                {IDEA_COLUMNS.map((col) => {
                  const inCol = items.filter((i) => i.state === col);
                  return (
                    <div className="im-col" key={col}>
                      <div className="im-colhead">
                        <span className={`lbl${col === 'Ready' ? ' ready' : ''}`}>{col}</span>
                        <span className="n">{inCol.length}</span>
                      </div>
                      {inCol.length ? inCol.map((idea) => (
                        <IdeaCard key={idea.id} idea={idea} open={open === idea.id}
                          onToggle={() => setOpen(open === idea.id ? null : idea.id)} />
                      )) : (
                        <span className="im-empty">Nothing here</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function AreaChip({ icon, label, count, active, onClick }: {
  icon?: KitIconName; label: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button className={`im-chip${active ? ' on' : ''}`} onClick={onClick} aria-pressed={active}>
      {icon && <span className="ico"><KitIcon name={icon} size={13} /></span>}
      {label}
      <span className="n">{count}</span>
    </button>
  );
}

function IdeaCard({ idea, open, onToggle }: {
  idea: MockIdea; open: boolean; onToggle: () => void;
}) {
  const ready = idea.state === 'Ready';
  const area = AREAS.find((a) => a.key === idea.area);
  return (
    <div className={`im-card${open ? ' open' : ''}${ready ? ' ready' : ''}`} onClick={onToggle}>
      <div className="im-cardtop">
        <span className="mark" style={ready ? { color: 'var(--lime-500)' } : undefined}>
          <KitIcon name="bookmark" size={14} />
        </span>
        <span className="t">{idea.title}</span>
        <span className="eff">{idea.effort}</span>
      </div>

      <span className={`im-note${open ? '' : ' clamp'}`}>{idea.note}</span>

      <div className="im-meta">
        <span className="k-tag mono">{idea.id}</span>
        {idea.tags.map((t) => <span key={t} className="k-tag">{t}</span>)}
        <span className="age">{idea.age}</span>
      </div>

      {open && (
        <div className="im-acts" onClick={(e) => e.stopPropagation()}>
          <span className="from">Captured {idea.from} · scoped to {area ? area.name : 'Global'}</span>
          <div className="btns">
            <button className={`k-btn sm ${ready ? 'accent' : 'secondary'}`}>
              <KitIcon name="arrow-up-right" size={13} />Promote to issue
            </button>
            <button className="k-btn sm ghost"><KitIcon name="layers" size={13} />Move area</button>
            <button className="k-btn sm ghost"><KitIcon name="trash-2" size={13} />Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
