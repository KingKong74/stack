// THE ROADMAP TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// `ui_kits/console/IdeasScreen.jsx` ported to TS, on the kit's own sample rows
// (MDP-1 … MDP-6). The tab that read `roadmap_items` — the Ready / Thinking /
// Parked columns derived from `tier`, `skipped` and the approval predicate, the
// HELD chip, ✓ Keep, Open, Park and Delete — was removed at the owner's request
// and replaced with this. BoardMock's header lists what that costs across both
// tabs; the two specific to this one:
//
//  • ✓ KEEP HAS NO SURFACE HERE ANY MORE, but it has one on For you →
//    Auto-ideas, which was always the queue you work THROUGH. A `hook` or `fly`
//    row still sits held until it is signed off there, so nothing is stranded.
//  • A HELD ROW NO LONGER APPEARS ON A SHELF. The first cut of the real screen
//    learned that an item on no screen is a lie of omission, and Auto-ideas is
//    now the only place one shows. That is one screen rather than two, not
//    zero — but it is a narrower net than it was.
//
// "Promote to issue", "Edit" and "Discard" below are the kit's own buttons and
// do nothing; the only live state is which card is expanded.

import { useState } from 'react';
import { KitIcon } from './kit/KitIcon';

type MockIdea = {
  id: string; title: string; state: 'Ready' | 'Thinking' | 'Parked';
  note: string; from: string; age: string; tags: string[]; effort: string;
};

const IDEAS: MockIdea[] = [
  {
    id: 'MDP-6', title: 'Column headers in mono', state: 'Ready',
    note: 'The sans reads too soft at 13px. Mono at 12 with caps tracking would hold the column edge.',
    from: 'while building the board', age: '2h', tags: ['type', 'board'], effort: 'S',
  },
  {
    id: 'MDP-5', title: 'Diff bars on every file row', state: 'Ready',
    note: 'Add/delete proportion bar next to the counts — cheap and it reads instantly.',
    from: 'from the working-copy panel', age: '5h', tags: ['viz'], effort: 'S',
  },
  {
    id: 'MDP-4', title: 'Virtualise the trail list too', state: 'Thinking',
    note: 'Same recycling trick as the columns. Only matters past ~400 rows, so probably not yet.',
    from: 'noted during KING-18', age: 'Mon', tags: ['perf'], effort: 'M',
  },
  {
    id: 'MDP-3', title: 'Model spend budget line', state: 'Thinking',
    note: 'Draw a target on the usage chart so overspend is visible without doing arithmetic.',
    from: 'after the $493 week', age: 'Mon', tags: ['usage'], effort: 'M',
  },
  {
    id: 'MDP-2', title: 'Terminal-first command palette', state: 'Parked',
    note: 'Everything reachable by keystroke from anywhere. Big, and the shell already does most of it.',
    from: 'sunday afternoon', age: 'Sun', tags: ['nav'], effort: 'L',
  },
  {
    id: 'MDP-1', title: 'Light mode', state: 'Parked',
    note: 'Palette inverts cleanly on paper, but I never work in daylight. Revisit if anyone else uses this.',
    from: 'from the token audit', age: '2 wk', tags: ['theme'], effort: 'L',
  },
];

const IDEA_COLUMNS: MockIdea['state'][] = ['Ready', 'Thinking', 'Parked'];

export function IdeasMock() {
  const [open, setOpen] = useState<string | null>('MDP-6');
  const ready = IDEAS.filter((i) => i.state === 'Ready').length;

  return (
    <div className="im">
      <div className="im-head">
        <div className="im-title">
          <span className="eyebrow">Workspace</span>
          <h1>Roadmap</h1>
        </div>
        <span className="im-lede">Rough notes stay here until they earn a branch.</span>
      </div>

      <div className="im-bar">
        <span className="searchbox sm im-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search ideas" aria-label="Search ideas" />
        </span>
        <span className="im-count">{IDEAS.length} captured · {ready} ready to promote</span>
        <button className="k-btn sm secondary im-capture">
          <KitIcon name="plus" size={14} />Capture idea
        </button>
      </div>

      <div className="im-cols">
        {IDEA_COLUMNS.map((col) => {
          const items = IDEAS.filter((i) => i.state === col);
          return (
            <div className="im-col" key={col}>
              <div className="im-colhead">
                <span className={`lbl${col === 'Ready' ? ' ready' : ''}`}>{col}</span>
                <span className="n">{items.length}</span>
              </div>
              {items.map((idea) => (
                <IdeaCard key={idea.id} idea={idea} open={open === idea.id}
                  onToggle={() => setOpen(open === idea.id ? null : idea.id)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IdeaCard({ idea, open, onToggle }: {
  idea: MockIdea; open: boolean; onToggle: () => void;
}) {
  const ready = idea.state === 'Ready';
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
          <span className="from">Captured {idea.from}</span>
          <div className="btns">
            <button className={`k-btn sm ${ready ? 'accent' : 'secondary'}`}>
              <KitIcon name="arrow-up-right" size={13} />Promote to issue
            </button>
            <button className="k-btn sm ghost"><KitIcon name="pencil" size={13} />Edit</button>
            <button className="k-btn sm ghost"><KitIcon name="trash-2" size={13} />Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
