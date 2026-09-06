// THE BOARD TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// This is `ui_kits/console/BoardScreen.jsx` ported to TS, on the kit's OWN
// sample rows (KING-07 … KING-41). ALL THREE OF ITS TABS ARE DRAWN — Board,
// Backlog and Development — and each is a mockup on the same terms; the two
// blocks further down say what the newer two would owe on their way to real
// data. It is not a view of this project: the board
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
// menu, its tooltip, the priority picker, the composer, the create dialog, the
// selected card, the backlog's grab handle and the branch folds. They persist
// nothing — closing the tab is the undo.

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

        {/* The kit's Tabs, underline variant. All three lead somewhere now:
            Board, Backlog (rank order) and Development (merge readiness), each
            the kit's own screen on the kit's own rows. Switching tabs changes
            which sample is drawn and nothing else — no route key, no fetch. */}
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

        {view === 'backlog' && <BacklogView onCreate={() => setDialog(true)} />}
        {view === 'dev' && <DevelopmentView />}

        {view === 'board' && <>
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
        </>}
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

/* ==========================================================================
   BACKLOG — `ui_kits/console/BoardScreen.jsx`'s BacklogView, ported.

   ORDER IS THE WHOLE POINT of this tab: the board pulls off the top, so a
   row's rank is what it says it is. In this app that rank is
   `roadmap_items.position`, the bucket tiebreak and the run queue's order —
   and the thing to know before wiring it up is that NOTHING IN THE CLIENT HAS
   EVER WRITTEN `position`. It is stored, served and PATCHable, and this is the
   first surface that has ever drawn it. The grab handle below moves nothing:
   it toggles one row's own styling and closing the tab is the undo.

   The WIP line is likewise the kit's arithmetic, not this project's. A real
   one would be the In Progress column's limit against the claimed rows, and
   `tier` — not rank — is the run queue's PRIMARY sort, so a backlog that
   ranked by position alone would order the night wrongly. Both are decisions
   for the wiring, stated here so the mockup is not mistaken for the design.
   ========================================================================== */

const WIP = 3;

type BacklogItem = {
  rank: number; id: string; title: string; kind: 'task' | 'idea';
  priority: PriorityKey; pts: number; area: string; from: string | null;
};

const BACKLOG: { batch: string; items: BacklogItem[] }[] = [
  {
    batch: 'Next batch',
    items: [
      { rank: 1, id: 'KING-33', title: 'Sidebar tree keyboard nav', kind: 'task', priority: 'high', pts: 5, area: 'Board and stack', from: 'MDP-5' },
      { rank: 2, id: 'KING-24', title: 'Audit contrast on dark surfaces', kind: 'task', priority: 'medium', pts: 3, area: 'Design system', from: null },
      { rank: 3, id: 'KING-36', title: 'Quarantine flaky checks', kind: 'idea', priority: 'high', pts: 3, area: 'Quality', from: 'MDP-9' },
      { rank: 4, id: 'KING-31', title: 'Split token files by concern', kind: 'idea', priority: 'low', pts: 2, area: 'Design system', from: 'MDP-6' },
    ],
  },
  {
    batch: 'Below the line',
    items: [
      { rank: 5, id: 'KING-38', title: 'Drag a timeline bar to move a date', kind: 'idea', priority: 'medium', pts: 5, area: 'Plans', from: 'MDP-10' },
      { rank: 6, id: 'KING-39', title: 'Second surface step for nested cards', kind: 'idea', priority: 'low', pts: 1, area: 'Design system', from: 'MDP-11' },
      { rank: 7, id: 'ATL-04', title: 'Print sheet geometry', kind: 'idea', priority: 'lowest', pts: 5, area: 'Print and export', from: 'MDP-7' },
      { rank: 8, id: 'KING-41', title: 'Budget line on the usage chart', kind: 'idea', priority: 'low', pts: 3, area: 'Plans', from: 'MDP-3' },
    ],
  },
];

function BacklogView({ onCreate }: { onCreate: () => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const total = BACKLOG.reduce((n, b) => n + b.items.length, 0);
  const pts = BACKLOG.reduce((n, b) => n + b.items.reduce((m, i) => m + i.pts, 0), 0);

  return (
    <div className="km-bl">
      <div className="km-bl-bar">
        <span className="searchbox sm km-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search backlog" aria-label="Search backlog" />
        </span>
        <button className="k-btn sm secondary"><KitIcon name="list-filter" size={14} />Area</button>
        <button className="k-btn sm secondary"><KitIcon name="layers" size={14} />Priority</button>
        <span className="km-bl-count">{total} queued · {pts} points · drag to reorder</span>
      </div>

      {/* The pull line: what the board takes next, said before anyone asks. */}
      <div className="km-pull">
        <span className="lbl">Next pulls</span>
        <span className="ids">
          {BACKLOG[0].items.slice(0, WIP).map((i) => (
            <span key={i.id} className="k-tag mono">{i.id}</span>
          ))}
        </span>
        <span className="say">In Progress holds {WIP} — the top {WIP} rows are what the board takes next.</span>
      </div>

      {BACKLOG.map((batch) => (
        <div className="km-batch" key={batch.batch}>
          <div className="km-batchhead">
            <span className="lbl">{batch.batch}</span>
            <span className="n">{batch.items.length}</span>
            <span className="rule" />
          </div>
          {batch.items.map((it) => (
            <BacklogRow key={it.id} row={it}
              dragging={drag === it.id}
              onGrab={() => setDrag(drag === it.id ? null : it.id)}
              cut={it.rank === WIP} />
          ))}
        </div>
      ))}

      <button className="km-bl-add" onClick={onCreate}>+ Add to backlog</button>
    </div>
  );
}

function BacklogRow({ row, dragging, onGrab, cut }: {
  row: BacklogItem; dragging: boolean; onGrab: () => void; cut: boolean;
}) {
  const pri = PRIORITIES.find((p) => p.value === row.priority) || PRIORITIES[2];
  return (
    <>
      <div className={`km-blrow${dragging ? ' dragging' : ''}`}>
        <button className="grip" aria-label={`Reorder ${row.id}`} onClick={onGrab}>⠿</button>
        <span className="rank">{row.rank}</span>
        <span className="kind" style={{ color: row.kind === 'idea' ? 'var(--lime-500)' : 'var(--blue-400)' }}>
          <KitIcon name={row.kind === 'idea' ? 'bookmark' : 'circle-check'} size={13} />
        </span>
        <span className="id">{row.id}</span>
        <span className="t">{row.title}</span>
        {row.from && <span className="from">from {row.from}</span>}
        <span className="k-tag">{row.area}</span>
        <span className="pri" style={{ color: pri.color }}>{pri.glyph}</span>
        <span className="pts">{row.pts}</span>
      </div>
      {cut && (
        <div className="km-cut">
          <span className="rule" />
          <span className="lbl">WIP limit {WIP}</span>
          <span className="rule" />
        </div>
      )}
    </>
  );
}

/* ==========================================================================
   DEVELOPMENT — `ui_kits/console/BoardScreen.jsx`'s DevelopmentView, ported.

   Branches in the order they can land. THE STATES BELOW ARE THE KIT'S FIVE
   STRINGS AND NOT THIS APP'S: `web/src/lib/branch.ts` derives a FOUR-valued
   merge state and its first rule is that `unprobed` is not `clean` — a branch
   nobody probed has to read as NO PASS RAN, never as mergeable. The kit has no
   such value ('never ran' here is a check string, not a merge state), so a
   wiring that maps these five onto those four by name will manufacture a green
   light. `branch.ts` is the definition; this is a picture.

   Every button in here is inert, and two of them matter enough to say so:
   Merge and Close branch are the actions #363's `merge_autonomy` and the
   conflict probe exist to gate, and no press here reaches either.
   ========================================================================== */

type BranchRowData = {
  branch: string; id: string; title: string; state: 'red' | 'running' | 'ready' | 'stale';
  pr: string; ahead: number; behind: number; add: number; del: number;
  checks: string; age: string;
  commits: { sha: string; msg: string }[];
  failing: string[];
};

type Tone = 'danger' | 'info' | 'warning' | 'success' | 'neutral';

const BRANCHES: { group: string; tone: Tone; rows: BranchRowData[] }[] = [
  {
    group: 'Needs you', tone: 'danger',
    rows: [
      {
        branch: 'king/token-split', id: 'KING-12', title: 'Replace legacy grey ramp', state: 'red',
        pr: 'PR #211', ahead: 6, behind: 0, add: 302, del: 96, checks: '2 failed', age: '4h',
        commits: [
          { sha: 'a7d31f0', msg: 'split colors, type, spacing into separate files' },
          { sha: '2c88b45', msg: 'point styles.css at the new imports' },
        ],
        failing: ['snapshot — Bugs collection', 'snapshot — bug→check link'],
      },
    ],
  },
  {
    group: 'In flight', tone: 'info',
    rows: [
      {
        branch: 'king/col-virtualisation', id: 'KING-18', title: 'Row recycling on scroll', state: 'running',
        pr: 'draft PR #212', ahead: 3, behind: 4, add: 148, del: 22, checks: 'running', age: '17m',
        commits: [
          { sha: '4f2ac1d', msg: 'wip: recycle row nodes on scroll' },
          { sha: '9be0742', msg: 'measure row height once per column' },
        ],
        failing: [],
      },
      {
        branch: 'king/diff-bar', id: 'KING-35', title: 'Extract the diff bar', state: 'ready',
        pr: 'PR #213', ahead: 2, behind: 0, add: 61, del: 44, checks: 'passing', age: '1d',
        commits: [{ sha: 'e91b204', msg: 'add DiffBar and replace three inline copies' }],
        failing: [],
      },
    ],
  },
  {
    group: 'Stale', tone: 'warning',
    rows: [
      {
        branch: 'king/print-styles', id: 'ATL-04', title: 'Print sheet geometry', state: 'stale',
        pr: 'no PR', ahead: 1, behind: 34, add: 210, del: 4, checks: 'never ran', age: '11d',
        commits: [{ sha: '5ea9c72', msg: 'first pass at print sheet geometry' }],
        failing: [],
      },
    ],
  },
];

const STATE_META: Record<BranchRowData['state'], { icon: 'circle-alert' | 'clock' | 'circle-check'; tone: Tone }> = {
  red: { icon: 'circle-alert', tone: 'danger' },
  running: { icon: 'clock', tone: 'warning' },
  ready: { icon: 'circle-check', tone: 'success' },
  stale: { icon: 'clock', tone: 'neutral' },
};

function DevelopmentView() {
  const [open, setOpen] = useState<string | null>('king/token-split');
  const mergeable = BRANCHES.flatMap((g) => g.rows).filter((r) => r.state === 'ready');

  return (
    <div className="km-dev">
      <div className="km-pull">
        <span className="lbl">Can land now</span>
        {mergeable.length ? (
          <>
            <span className="ids">
              {mergeable.map((r) => <span key={r.branch} className="k-tag mono">{r.branch}</span>)}
            </span>
            <button className="k-btn sm accent">
              <KitIcon name="git-branch" size={13} />Merge {mergeable.length}
            </button>
          </>
        ) : (
          <span className="say">Nothing is green and ahead of main.</span>
        )}
      </div>

      {BRANCHES.map((g) => (
        <div className="km-devgroup" key={g.group}>
          <div className="km-batchhead">
            <span className={`lbl tone-${g.tone}`}>{g.group}</span>
            <span className="n">{g.rows.length}</span>
            <span className="rule" />
          </div>
          {g.rows.map((r) => (
            <BranchRow key={r.branch} row={r} open={open === r.branch}
              onToggle={() => setOpen(open === r.branch ? null : r.branch)} />
          ))}
        </div>
      ))}
    </div>
  );
}

function BranchRow({ row, open, onToggle }: {
  row: BranchRowData; open: boolean; onToggle: () => void;
}) {
  const meta = STATE_META[row.state];
  return (
    <section className={`km-branch${open ? ' open' : ''}`}>
      <button className="km-branchhead" onClick={onToggle} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`km-branchico tone-${meta.tone}`}><KitIcon name={meta.icon} size={13} /></span>

        <span className="mid">
          <span className="top">
            <span className="br">{row.branch}</span>
            <span className="id">{row.id}</span>
          </span>
          <span className="sub">{row.title} · {row.pr}</span>
        </span>

        <span className="delta">↑{row.ahead} ↓{row.behind}</span>
        <span className="diff">
          <span className="add">+{row.add}</span>
          <span className="del">−{row.del}</span>
        </span>
        <span className={meta.tone === 'neutral' ? 'k-tag' : `k-tag ${meta.tone}`}>{row.checks}</span>
        <span className="age">{row.age}</span>
      </button>

      {open && (
        <div className="km-branchbody">
          <div className="commits">
            {row.commits.map((c) => (
              <div className="commit" key={c.sha}>
                <span className="sha">{c.sha}</span>
                <span className="msg">{c.msg}</span>
              </div>
            ))}
          </div>

          {row.failing.length > 0 && (
            <div className="failing">
              {row.failing.map((f) => (
                <span className="fail" key={f}><KitIcon name="circle-alert" size={13} />{f}</span>
              ))}
            </div>
          )}

          <div className="acts">
            {row.state === 'ready' && (
              <button className="k-btn sm accent"><KitIcon name="git-branch" size={13} />Merge</button>
            )}
            {row.state === 'red' && (
              <button className="k-btn sm secondary"><KitIcon name="circle-alert" size={13} />Open failing run</button>
            )}
            {row.behind > 0 && <button className="k-btn sm secondary">Rebase on main</button>}
            <button className="k-btn sm ghost"><KitIcon name="code" size={13} />Check out</button>
            {row.state === 'stale' && <button className="k-btn sm danger">Close branch</button>}
          </div>
        </div>
      )}
    </section>
  );
}
