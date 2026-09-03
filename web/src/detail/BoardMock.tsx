// THE BOARD TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// This is `ui_kits/console/BoardScreen.jsx` ported to TS, on the kit's OWN
// sample rows (KING-07 … KING-33). It is not a view of this project: the board
// that read `roadmap_items` — its lanes, its drag, its labels, its area chips,
// its archive, its park/unpark, its ✓ Review verdict panel and the scope
// picker — was removed at the owner's request and replaced with this. Nothing
// here calls `store.ts`, and nothing here can.
//
// WHAT THAT COST, stated once so nobody has to rediscover it:
//
//  • THE VERDICT HAS NO SURFACE ANYWHERE IN THE APP. Mission Control's Review
//    room was culled and this board was the only place left a human could
//    record one, so `review_tag`, `verdict_source`, `verdict_at` and
//    `verdict_evidence` are now written by the auto-verdict path (#263) and by
//    nothing else. #263's third leg is VISIBLE — a machine verdict has to be
//    readable by the human it stands in for — and there is currently no screen
//    that reads it. Whatever surfaces a change next has to carry it.
//  • PARK/UNPARK, ARCHIVE, DELETE, LABELS and MOVE-BETWEEN-LANES are likewise
//    unreachable from the UI. The columns and the routes are all still there
//    (`skipped`, `archived`, `project_labels`, `list_key`, `PATCH /roadmap/:id`,
//    `POST /board/labels`), and the overnight runner still reads every one of
//    them — so a parked item stays parked and nothing can unpark it from a
//    browser. `./stack` and the API are the way back.
//  • `hl` ON THIS TAB NAMES A ROW THIS SCREEN CANNOT DRAW. The route still
//    resolves (lib/route.ts), the deep link still lands here, and the highlight
//    is simply ignored rather than 404ing.
//  • FOURTEEN LINKS IN THE REST OF THE APP STILL POINT AT THIS TAB, and every
//    one of them now dead-ends on sample rows: Overview's "Next up", "Shipped"
//    and verdict-queue rows (its ✓ Review button most of all), the Timeline's
//    bars, the Terminal's working-item strip, and the ＋ dock's "filed — go
//    look". They RESOLVE, so none of them is the broken-link failure `#/control`
//    exists to avoid, but each one promises a row it cannot show. They were
//    left alone on purpose rather than quietly rewritten: they belong to
//    screens the owner has not asked to change, and where they should point
//    instead is a decision, not a tidy-up.
//
// The interactions BELOW are the kit's own and are all local state: the column
// menu, its tooltip, the priority picker, the composer, the create dialog and
// the selected card. They persist nothing — closing the tab is the undo.

import { useEffect, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';

type PriorityKey = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

// THE TWO RED ONES USE THE TEXT TONE, NOT THE RAMP VALUE. The kit spells these
// `--red-500`, which is the fill red — and the palette audit measured it at
// 4.17:1 as a glyph on `--surface-raised`, under AA. `--status-danger-fg` is
// the same red sized to be READ on a dark ground, which is the "a fill tone is
// not a text tone" rule #432 learned the hard way and the only deliberate
// departure from the kit's own values in either mockup. Amber and blue are the
// kit's, unchanged: both measure clear.
const PRIORITIES: { value: PriorityKey; label: string; glyph: string; color: string }[] = [
  { value: 'highest', label: 'Highest', glyph: '⌃⌃', color: 'var(--status-danger-fg)' },
  { value: 'high', label: 'High', glyph: '⌃', color: 'var(--status-danger-fg)' },
  { value: 'medium', label: 'Medium', glyph: '=', color: 'var(--amber-500)' },
  { value: 'low', label: 'Low', glyph: '⌄', color: 'var(--blue-400)' },
  { value: 'lowest', label: 'Lowest', glyph: '⌄⌄', color: 'var(--blue-400)' },
];

type MockCard = {
  id: string; title: string; kind: 'task' | 'idea';
  priority: PriorityKey; pts: number; tag: string;
};

const COLUMNS: { key: string; name: string; limit: number | null; items: MockCard[] }[] = [
  {
    key: 'todo',
    name: 'To Do',
    limit: null,
    items: [
      { id: 'KING-24', title: 'Audit contrast on dark surfaces', kind: 'task', priority: 'medium', pts: 3, tag: 'Design' },
      { id: 'KING-31', title: 'Split token files by concern', kind: 'idea', priority: 'low', pts: 2, tag: 'Tokens' },
      { id: 'KING-33', title: 'Sidebar tree keyboard nav', kind: 'task', priority: 'high', pts: 5, tag: 'A11y' },
    ],
  },
  {
    key: 'progress',
    name: 'In Progress',
    limit: 3,
    items: [
      { id: 'KING-18', title: 'Row recycling on scroll', kind: 'task', priority: 'highest', pts: 8, tag: 'Perf' },
    ],
  },
  {
    key: 'review',
    name: 'In Review',
    limit: null,
    items: [
      { id: 'KING-12', title: 'Replace legacy grey ramp', kind: 'task', priority: 'medium', pts: 3, tag: 'Tokens' },
    ],
  },
  {
    key: 'done',
    name: 'Done',
    limit: null,
    items: [
      { id: 'KING-07', title: 'Ship Button and IconButton', kind: 'task', priority: 'low', pts: 2, tag: 'Components' },
      { id: 'KING-09', title: 'Focus ring spec', kind: 'idea', priority: 'lowest', pts: 1, tag: 'A11y' },
    ],
  },
];

const CARD_COUNT = COLUMNS.reduce((n, c) => n + c.items.length, 0);

export function BoardMock() {
  const [view, setView] = useState('board');
  const [selected, setSelected] = useState<string | null>('KING-18');
  const [menu, setMenu] = useState<string | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [priorityOf, setPriorityOf] = useState<Record<string, PriorityKey>>(() => {
    const m: Record<string, PriorityKey> = {};
    COLUMNS.forEach((c) => c.items.forEach((i) => { m[i.id] = i.priority; }));
    return m;
  });
  const [priMenu, setPriMenu] = useState<string | null>(null);

  return (
    <>
      <div className="km" onClick={() => { setMenu(null); setPriMenu(null); }}>
        <div className="km-head">
          <span className="km-crumb">Spaces / King</span>
          <div className="km-headrow">
            <h1>Stack</h1>
            <span className="k-tag mono">KING</span>
            <button className="k-btn sm km-create" onClick={() => setDialog(true)}>
              <KitIcon name="plus" size={14} />Create issue
            </button>
          </div>
        </div>

        {/* The kit's Tabs, underline variant. Board is the only one drawn — the
            other two are labels in the mockup and lead nowhere, which is what
            a mockup's tabs do. */}
        <div className="k-tabs km-tabs">
          {[
            { value: 'board', label: 'Board', count: CARD_COUNT },
            { value: 'backlog', label: 'Backlog' },
            { value: 'dev', label: 'Development' },
          ].map((t) => (
            <button key={t.value} className={`k-tab${view === t.value ? ' on' : ''}`}
              onClick={() => setView(t.value)}>
              {t.label}
              {t.count !== undefined && <span className="n">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="k-banner warning km-banner">
          <div className="k-banner-text">
            <span className="k-banner-title">One check red on the in-progress card</span>
            <span className="k-banner-body">Snapshot suite has failed twice on king/col-virtualisation.</span>
          </div>
          <button className="k-btn sm secondary">Open run</button>
        </div>

        <div className="km-toolbar">
          <span className="km-avatars">
            <span className="km-av ghost"><KitIcon name="users" size={13} /></span>
            <span className="km-av me">BK</span>
          </span>
          <button className="k-btn sm secondary"><KitIcon name="list-filter" size={14} />Filter</button>
          <button className="k-btn sm secondary"><KitIcon name="layers" size={14} />Group</button>
          <span className="searchbox sm km-search">
            <KitIcon name="search" size={14} />
            <input placeholder="Search board" aria-label="Search board" />
          </span>
          <span className="km-views">
            <button className="k-iconbtn sm solid on" aria-label="Board view"><KitIcon name="layout-grid" size={15} /></button>
            <button className="k-iconbtn sm solid" aria-label="List view"><KitIcon name="list" size={15} /></button>
          </span>
        </div>

        <div className="km-cols">
          {COLUMNS.map((col, ci) => (
            <div className="km-col" key={col.key}>
              <ColumnHead col={col} ci={ci} last={ci === COLUMNS.length - 1}
                open={menu === col.key}
                onMenu={(e) => {
                  e.stopPropagation();
                  setPriMenu(null);
                  setMenu(menu === col.key ? null : col.key);
                }} />

              {col.items.map((it) => (
                <IssueCard key={it.id} item={it}
                  priority={priorityOf[it.id]}
                  selected={selected === it.id}
                  onSelect={() => setSelected(it.id)}
                  priOpen={priMenu === it.id}
                  onPri={(e) => {
                    e.stopPropagation();
                    setMenu(null);
                    setPriMenu(priMenu === it.id ? null : it.id);
                  }}
                  onPick={(v) => { setPriorityOf({ ...priorityOf, [it.id]: v }); setPriMenu(null); }} />
              ))}

              {composer === col.key ? (
                <Composer onClose={() => setComposer(null)} />
              ) : (
                <button className="km-add" onClick={(e) => { e.stopPropagation(); setComposer(col.key); }}>
                  <KitIcon name="plus" size={14} />Create
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {dialog && (
        <div className="km-scrim" onClick={() => setDialog(false)}>
          <div className="km-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="km-dialog-head">
              <span className="t">Create issue</span>
              <span className="d">It lands at the top of To Do.</span>
            </div>
            <label className="km-field">
              <span className="lbl">Summary</span>
              <span className="searchbox km-input"><input placeholder="Short, imperative" /></span>
            </label>
            <label className="km-field">
              <span className="lbl">Type</span>
              <select className="km-select" defaultValue="Task">
                <option>Task</option><option>Bug</option><option>Story</option>
              </select>
            </label>
            <div className="km-dialog-foot">
              <button className="k-btn ghost" onClick={() => setDialog(false)}>Cancel</button>
              <button className="k-btn" onClick={() => setDialog(false)}>Create</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ColumnHead({ col, ci, last, open, onMenu }: {
  col: { key: string; name: string; limit: number | null; items: MockCard[] };
  ci: number; last: boolean; open: boolean;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [tip, setTip] = useState(false);
  return (
    <div className="km-colhead">
      <span className="nm">{col.name}</span>
      <span className="k-badge">{col.items.length}</span>
      {col.limit !== null && <span className="lim">max {col.limit}</span>}

      <span className="tools">
        <button className="km-colbtn" aria-label="Collapse column">→←</button>
        <button className={`km-colbtn${open ? ' on' : ''}`} aria-label="More actions" onClick={onMenu}
          onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
          <KitIcon name="ellipsis" size={15} />
        </button>
      </span>

      {tip && !open && <span className="km-tip">More actions</span>}

      {open && (
        <div className="km-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button className="km-menuitem">Set column limit</button>
          <span className="km-menusep" />
          <button className="km-menuitem" disabled={ci === 0}>Move column left</button>
          <button className="km-menuitem" disabled={last}>Move column right</button>
          <span className="km-menusep" />
          <button className="km-menuitem danger">Delete status</button>
        </div>
      )}
    </div>
  );
}

function IssueCard({ item, priority, selected, onSelect, priOpen, onPri, onPick }: {
  item: MockCard;
  priority: PriorityKey;
  selected: boolean;
  onSelect: () => void;
  priOpen: boolean;
  onPri: (e: React.MouseEvent) => void;
  onPick: (v: PriorityKey) => void;
}) {
  const pri = PRIORITIES.find((p) => p.value === priority) || PRIORITIES[2];
  return (
    <div className={`km-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="t">{item.title}</span>

      <div className="km-cardmeta">
        <span className="kind" style={{ color: item.kind === 'idea' ? 'var(--lime-500)' : 'var(--blue-400)' }}>
          <KitIcon name={item.kind === 'idea' ? 'bookmark' : 'circle-check'} size={13} />
        </span>
        <span className="id">{item.id}</span>
        <span className="pts">{item.pts}</span>

        <span className="right">
          <button className={`km-pri${priOpen ? ' on' : ''}`} aria-label="Priority"
            style={{ color: pri.color }} onClick={onPri}>
            {pri.glyph}
          </button>
          <span className="km-av ghost sm"><KitIcon name="users" size={11} /></span>
        </span>
      </div>

      {priOpen && (
        <div className="km-prilist" role="menu" onClick={(e) => e.stopPropagation()}>
          <span className="cur">
            <span className="g" style={{ color: pri.color }}>{pri.glyph}</span>
            {pri.label}
          </span>
          <div className="opts">
            {PRIORITIES.map((p) => {
              const on = p.value === priority;
              return (
                <button key={p.value} className={`opt${on ? ' on' : ''}`} onClick={() => onPick(p.value)}>
                  <span className="g" style={on ? undefined : { color: p.color }}>{p.glyph}</span>
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="km-composer" onClick={(e) => e.stopPropagation()}>
      <textarea ref={ref} rows={2} value={text} placeholder="What needs to be done?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
      <div className="km-composer-foot">
        <button className="ic" aria-label="Work type" style={{ color: 'var(--lime-500)' }}>
          <KitIcon name="bookmark" size={14} /><span className="chev">▾</span>
        </button>
        <button className="ic" aria-label="Due date"><KitIcon name="calendar" size={14} /></button>
        <button className="ic" aria-label="Assign"><KitIcon name="users" size={14} /></button>
        <button className={`go${text ? ' armed' : ''}`} aria-label="Add item" onClick={onClose}>
          {'⏎'}
        </button>
      </div>
    </div>
  );
}
