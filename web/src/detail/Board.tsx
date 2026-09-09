// THE BOARD IS WIRED. Its kanban reads `roadmap_items` and writes them back;
// the Backlog and Development tabs below it are still the kit's mockups.
//
// This is `ui_kits/console/BoardScreen.jsx` ported to TS (#443/#447) and then
// given the data it was drawn for. The kanban half now reads the project's own
// roadmap through `store.ts` and its columns through `GET /board`, and every
// control on it writes: the priority picker, the drag between columns, the
// column head's rename / move / delete, the lane composer, the create dialog
// and the card menu. Nothing here fetches for itself except the column list —
// the CARDS arrive as a prop, from the one payload every tab renders from, so
// a write patches that payload rather than re-reading the project.
//
// EIGHT DECISIONS THE WIRING MADE. Each one is a place where the kit's picture
// and this app's data disagreed, and the data won:
//
//  1. THE PRIORITY CONTROL IS `bucket`, AND IT HAS FOUR OPTIONS, NOT FIVE. The
//     kit draws Highest…Lowest. Stack stores MoSCoW, so the picker offers Must,
//     Should, Could and Won't and writes the column those names belong to. It
//     is deliberately NOT `tier`: the desire tier is the item modal's and
//     nowhere else's (CLAUDE.md), and a five-slot picker on a card is exactly
//     the second writer that rule exists to prevent.
//  2. THE COLUMN ORDER IS THE RUN QUEUE'S ORDER, not the payload's. `queueOrder`
//     in lib/plan.ts sorts tier-then-bucket over an array that arrived in
//     position order — read its header before touching either. The top of To Do
//     is a claim about what the night takes next, so it has to be the same
//     ordering the runner picks with.
//  3. DRAGGING TO Done DOES NOT TICK. A drop writes `list_key` and only that:
//     server/src/lists.js is explicit that a board column is not a verdict, and
//     `done` is what `computeProgress` weighs and what the merge job writes.
//     Dropping a card back on the column it would derive into writes '' rather
//     than the key, so a card only carries an override while it needs one.
//  4. THERE IS NO WITHIN-COLUMN DRAG. `position` is scoped to the BUCKET, not
//     to the list — the server orders `bucket, position, created_at` and four
//     lists cut across all four buckets — so a reorder inside In Progress would
//     write a number that means something else. Writing `position` is the
//     BACKLOG's job (it ranks one flat list) and it is still unwired.
//  5. NO COLUMN LIMIT. The kit's "max 3" chip and its Set column limit menu item
//     are gone: `project_lists` stores no limit, and inventing one here would be
//     a second truth about concurrency next to `autopilotWorkers` — which is a
//     FLEET cap, not a column's.
//  6. NO ASSIGNEE AVATARS AND NO LIST/BOARD VIEW TOGGLE. Stack has no assignees
//     and this screen has one layout; two buttons where one does nothing is a
//     lie the mockup could afford and a wired screen cannot. The kit's check-run
//     banner went for the same reason — the board reads no checks.
//  7. `hl` NAMES A ROW THIS SCREEN CAN DRAW AGAIN. Every card carries
//     `data-hl`, so the fourteen links that dead-ended here since #443 —
//     Overview's Next up and Shipped rows, the Timeline's bars, the Terminal's
//     working-item strip, the + dock's "filed — go look" — land on their row
//     and scroll to it. It is the first tab to honour a highlight since #444.
//  8. A CATCH-ALL COLUMN IS NOT OPTIONAL. Every lane renames and deletes (#428),
//     and `listKeyOf` still derives into four keys, so a board missing one of
//     them has cards with nowhere to render — counted everywhere else and
//     invisible here, the worst kind of loss. `lists.js` allows the delete only
//     because this lane exists. Do not remove it.
//
// WHAT THE CARD MENU GIVES BACK, since #443 and #444 took all four: PARK and
// UNPARK (a parked item stays parked and nothing in a browser could unpark it),
// ARCHIVE, DELETE (which tombstones a `hook` row's fingerprint, which is what
// Dismiss means and why it has no undo), and the SIGN-OFF that releases a
// held `hook`/`fly` row to the overnight runner (#359 — `lib/approval.ts` is
// the rule and no browser has been able to answer it since #444). Editing opens
// the item modal this screen is handed, which is still the only writer of
// `tier` and of a human `risk_source`.
//
// STILL UNREACHABLE FROM ANY BROWSER, so nobody re-discovers it here: GIVING A
// VERDICT. `review_tag` and the #263 trio arrive from the auto path alone, and
// #263's third leg — a machine verdict must be READABLE by the human it stands
// in for — is unmet. This screen draws a verdicted card in Done and says the
// verdict came from a machine, which is not the same as letting anyone disagree
// with it. Whatever surfaces a change next still owes both.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { BoardList, Priority, RoadmapItem } from '../types';
import { listKeyOf, queueOrder } from '../lib/plan';
import { isHeld } from '../lib/approval';
import {
  getBoardShape, createList, patchList, deleteList,
  createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
} from '../store';

// THE RED AND AMBER GLYPHS USE TEXT TONES, NOT RAMP VALUES. The kit spells its
// priority glyphs `--red-500`, which is the FILL red — the palette audit
// measured it at 4.17:1 as a glyph on `--surface-raised`, under AA.
// `--status-danger-fg` is the same red sized to be READ on a dark ground: "a
// fill tone is not a text tone" (#432), and the only departure from the kit's
// own values here. Won't-do is deliberately the quietest of the four.
const BUCKETS: { value: Priority; label: string; glyph: string; color: string }[] = [
  { value: 'must', label: 'Must', glyph: '⌃⌃', color: 'var(--status-danger-fg)' },
  { value: 'should', label: 'Should', glyph: '⌃', color: 'var(--amber-500)' },
  { value: 'could', label: 'Could', glyph: '=', color: 'var(--blue-400)' },
  { value: 'wont', label: "Won't", glyph: '⌄', color: 'var(--text-secondary)' },
];
const bucketMeta = (b: Priority) => BUCKETS.find((x) => x.value === b) || BUCKETS[2];

// The lane for a card whose derived key has no column — decision 8 above. The
// leading space is what keeps it off `project_lists`, whose keys are slugs.
const CATCH_ALL = ' unlisted';

/**
 * Where a card would sit if it carried no override. `listKeyOf` returns the
 * stored `listKey` when there is one, which is right for DRAWING and wrong for
 * deciding whether a drop still needs an override — so blank it and ask again.
 */
const derivedKeyOf = (it: RoadmapItem): string => listKeyOf({ ...it, listKey: '' });

export function Board({ slug, projectName, items, onRefresh, onEdit, highlightId }: {
  slug: string;
  projectName: string;
  /** The project payload's own roadmap, flattened and IN PAYLOAD ORDER — see
   *  `queueOrder`, which relies on that order for its last sort key. */
  items: RoadmapItem[];
  /** Re-read the project payload. Called after every write that landed. */
  onRefresh: () => void;
  /** Open the item modal — still the only writer of `tier` and a human `risk`. */
  onEdit: (it: RoadmapItem) => void;
  highlightId: string | null;
}) {
  const [view, setView] = useState('board');

  // The rows this screen draws. Seeded from the payload and re-seeded whenever
  // it changes, but written THROUGH by every mutation below so a card moves
  // under the cursor rather than after a round trip. The write's own response
  // is the authority in between.
  const [rows, setRows] = useState<RoadmapItem[]>(items);
  useEffect(() => { setRows(items); }, [items]);

  const [lists, setLists] = useState<BoardList[] | null>(null);
  const [areaNames, setAreaNames] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const loadShape = useCallback(async () => {
    const shape = await getBoardShape(slug);
    setLists([...shape.lists].sort((a, b) => a.position - b.position || a.id - b.id));
    setAreaNames(shape.areas.map((a) => a.name));
  }, [slug]);

  useEffect(() => {
    let live = true;
    loadShape().catch((e) => {
      // A board that cannot read its columns is not a board, so this one says
      // so rather than drawing four it invented — the columns are the owner's,
      // and guessing them would file cards under names nobody chose.
      if (live) setErr((e as Error)?.message || 'Could not read this board’s columns.');
    });
    return () => { live = false; };
  }, [loadShape]);

  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); }
    catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
  };

  // Replace one row in place, then re-read in the background. The in-place swap
  // is what the eye follows; the re-read is what catches everything the write
  // touched that the response does not carry.
  const wrote = (updated: RoadmapItem) => {
    setRows((r) => r.map((x) => (x.id === updated.id ? updated : x)));
    onRefresh();
  };

  // ---- filters --------------------------------------------------------------
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('');
  // Parked cards SHOW by default. Hiding them by default is how a parked item
  // becomes invisible work, which is the state #247 existed to end.
  const [hideParked, setHideParked] = useState(false);
  const [areaOpen, setAreaOpen] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((it) => !it.archived)
      .filter((it) => (hideParked ? !it.skipped : true))
      .filter((it) => (area ? it.area === area : true))
      .filter((it) => !needle
        || it.title.toLowerCase().includes(needle)
        || it.note.toLowerCase().includes(needle)
        || String(it.id) === needle.replace(/^#/, ''));
  }, [rows, query, area, hideParked]);

  // ---- the columns ----------------------------------------------------------
  const columns = useMemo(() => {
    const known = new Set((lists || []).map((l) => l.key));
    const byKey = new Map<string, RoadmapItem[]>();
    for (const it of visible) {
      const derived = listKeyOf(it);
      const key = known.has(derived) ? derived : CATCH_ALL;
      const bag = byKey.get(key);
      if (bag) bag.push(it); else byKey.set(key, [it]);
    }
    // `queueOrder` is a STABLE sort over payload order — see its header.
    for (const bag of byKey.values()) bag.sort(queueOrder);
    const out = (lists || []).map((l) => ({ key: l.key, name: l.name, items: byKey.get(l.key) || [], real: true }));
    const orphans = byKey.get(CATCH_ALL);
    if (orphans?.length) out.push({ key: CATCH_ALL, name: 'No column', items: orphans, real: false });
    return out;
  }, [visible, lists]);

  const onBoard = rows.filter((it) => !it.archived);
  const shown = columns.reduce((n, c) => n + c.items.length, 0);
  const parked = onBoard.filter((it) => it.skipped).length;

  // ---- card writes ----------------------------------------------------------
  const setBucket = (it: RoadmapItem, bucket: Priority) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { bucket })); });

  // A drop writes `list_key` — and '' when the target IS the derived column, so
  // a card only carries an override for as long as it is somewhere its own
  // state would not have put it. Decision 3.
  const moveTo = (it: RoadmapItem, key: string) => {
    if (key === CATCH_ALL || listKeyOf(it) === key) return;
    return guard(async () => {
      wrote(await patchRoadmapItem(slug, it.id, { listKey: derivedKeyOf(it) === key ? '' : key }));
    });
  };

  const park = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { skipped: !it.skipped })); });
  const signOff = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { reviewed: true })); });
  const archive = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { archived: true })); });
  const derive = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { listKey: '' })); });
  const remove = (it: RoadmapItem) =>
    guard(async () => {
      await deleteRoadmapItem(slug, it.id);
      setRows((r) => r.filter((x) => x.id !== it.id));
      onRefresh();
    });

  // A card born in a column that is not its derived one carries the override
  // from the start; one born in To Do does not, because it would derive there
  // anyway. Two calls rather than one because POST has no `listKey`.
  const add = (title: string, bucket: Priority, key: string) =>
    guard(async () => {
      const made = await createRoadmapItem(slug, { title, note: '', bucket });
      const final = key && key !== CATCH_ALL && derivedKeyOf(made) !== key
        ? await patchRoadmapItem(slug, made.id, { listKey: key })
        : made;
      setRows((r) => [...r, final]);
      onRefresh();
    });

  // ---- column writes --------------------------------------------------------
  const renameCol = (key: string, name: string) =>
    guard(async () => { await patchList(slug, key, { name }); await loadShape(); });
  // A SWAP of two positions, which is what the server's PATCH takes and what a
  // left/right press actually means. The neighbour is whatever is next in the
  // drawn order, so a board with holes in its positions still moves correctly.
  const moveCol = (key: string, dir: -1 | 1) =>
    guard(async () => {
      const all = lists || [];
      const i = all.findIndex((l) => l.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= all.length) return;
      await patchList(slug, key, { position: all[j].position });
      await loadShape();
    });
  const dropCol = (key: string) =>
    guard(async () => { await deleteList(slug, key); await loadShape(); onRefresh(); });
  const addCol = (name: string) =>
    guard(async () => { await createList(slug, name); await loadShape(); });

  // ---- transient UI ---------------------------------------------------------
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState<string | null>(null);          // open column menu
  const [cardMenu, setCardMenu] = useState<number | null>(null);  // open card menu
  const [priMenu, setPriMenu] = useState<number | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const closeAll = () => { setMenu(null); setPriMenu(null); setCardMenu(null); setAreaOpen(false); };

  // A deep link SELECTS its row; the scroll to it is ProjectDetail's, off the
  // `data-hl` each card now carries.
  useEffect(() => {
    const n = Number(highlightId);
    if (Number.isFinite(n) && n > 0) setSelected(n);
  }, [highlightId]);

  return (
    <>
      <div className="km" onClick={closeAll}>
        <div className="km-head">
          <span className="km-crumb">Spaces / {projectName}</span>
          <div className="km-headrow">
            <h1>{projectName}</h1>
            <span className="k-tag mono">{slug}</span>
            <button className="k-btn sm km-create" onClick={() => setDialog(true)}>
              <KitIcon name="plus" size={14} />Create issue
            </button>
          </div>
        </div>

        {/* Board is wired; the other two are still the kit's mockups, and their
            blocks further down say what each would owe on the way to real data.
            Switching tabs changes which is drawn and nothing else — no route
            key, no fetch. */}
        <div className="k-tabs km-tabs">
          {[
            { value: 'board', label: 'Board', count: shown },
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

        {err && <div className="km-err" role="alert">{err}</div>}

        {view === 'backlog' && <BacklogView onCreate={() => setDialog(true)} />}
        {view === 'dev' && <DevelopmentView />}

        {view === 'board' && <>
        <div className="km-toolbar">
          <span className="searchbox sm km-search">
            <KitIcon name="search" size={14} />
            <input placeholder="Search board" aria-label="Search board" value={query}
              onChange={(e) => setQuery(e.target.value)} />
          </span>

          <span className="km-filter">
            <button className={`k-btn sm secondary${area ? ' on' : ''}`}
              onClick={(e) => { e.stopPropagation(); closeAll(); setAreaOpen(!areaOpen); }}>
              <KitIcon name="list-filter" size={14} />{area || 'All areas'}
            </button>
            {areaOpen && (
              <div className="km-menu left" role="menu" onClick={(e) => e.stopPropagation()}>
                <button className="km-menuitem" onClick={() => { setArea(''); setAreaOpen(false); }}>All areas</button>
                {areaNames.length > 0 && <span className="km-menusep" />}
                {areaNames.map((a) => (
                  <button key={a} className="km-menuitem" onClick={() => { setArea(a); setAreaOpen(false); }}>{a}</button>
                ))}
              </div>
            )}
          </span>

          {/* Parked is a FILTER and never the default — see `hideParked`. */}
          <button className={`k-btn sm secondary km-parked${hideParked ? ' on' : ''}`}
            onClick={() => setHideParked(!hideParked)}
            title="Parked items are planned and deliberately not picked up. The overnight runner skips them.">
            <KitIcon name="layers" size={14} />{hideParked ? 'Parked hidden' : `Parked shown${parked ? ` (${parked})` : ''}`}
          </button>

          <span className="km-count">{shown} of {onBoard.length} on the board</span>
        </div>

        <div className="km-cols">
          {columns.map((col, ci) => (
            <div key={col.key}
              className={`km-col${over === col.key ? ' over' : ''}${col.real ? '' : ' catchall'}`}
              onDragOver={(e) => { if (dragId !== null && col.real) { e.preventDefault(); setOver(col.key); } }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const it = rows.find((x) => x.id === dragId);
                setDragId(null);
                if (it && col.real) moveTo(it, col.key);
              }}>
              <ColumnHead col={col} first={ci === 0} last={ci === columns.length - 1}
                open={menu === col.key}
                onMenu={(e) => { e.stopPropagation(); closeAll(); setMenu(menu === col.key ? null : col.key); }}
                onRename={(name) => { setMenu(null); renameCol(col.key, name); }}
                onMove={(d) => { setMenu(null); moveCol(col.key, d); }}
                onDelete={() => { setMenu(null); dropCol(col.key); }} />

              {col.items.map((it) => (
                <IssueCard key={it.id} item={it}
                  selected={selected === it.id}
                  onSelect={() => setSelected(it.id)}
                  dragging={dragId === it.id}
                  onDragStart={() => { closeAll(); setDragId(it.id); }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  priOpen={priMenu === it.id}
                  onPri={(e) => { e.stopPropagation(); closeAll(); setPriMenu(priMenu === it.id ? null : it.id); }}
                  onPick={(v) => { setPriMenu(null); setBucket(it, v); }}
                  menuOpen={cardMenu === it.id}
                  onMenu={(e) => { e.stopPropagation(); closeAll(); setCardMenu(cardMenu === it.id ? null : it.id); }}
                  onEdit={() => { setCardMenu(null); onEdit(it); }}
                  onPark={() => { setCardMenu(null); park(it); }}
                  onSignOff={() => { setCardMenu(null); signOff(it); }}
                  onArchive={() => { setCardMenu(null); archive(it); }}
                  onDerive={() => { setCardMenu(null); derive(it); }}
                  onDelete={() => { setCardMenu(null); remove(it); }} />
              ))}

              {col.items.length === 0 && <span className="km-colempty">Nothing here</span>}

              {col.real && (composer === col.key ? (
                <Composer onClose={() => setComposer(null)}
                  onAdd={(text, bucket) => { setComposer(null); add(text, bucket, col.key); }} />
              ) : (
                <button className="km-add" onClick={(e) => { e.stopPropagation(); closeAll(); setComposer(col.key); }}>
                  <KitIcon name="plus" size={14} />Create
                </button>
              ))}
            </div>
          ))}

          {lists && <AddColumn onAdd={addCol} />}
        </div>
        </>}
      </div>

      {dialog && (
        <CreateDialog onClose={() => setDialog(false)}
          onCreate={(title, bucket) => { setDialog(false); add(title, bucket, ''); }} />
      )}
    </>
  );
}

function ColumnHead({ col, first, last, open, onMenu, onRename, onMove, onDelete }: {
  col: { key: string; name: string; items: RoadmapItem[]; real: boolean };
  first: boolean; last: boolean; open: boolean;
  onMenu: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [tip, setTip] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(col.name);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open) setConfirming(false); }, [open]);

  if (editing) {
    const commit = () => {
      const name = draft.trim();
      setEditing(false);
      if (name && name !== col.name) onRename(name);
    };
    return (
      <div className="km-colhead">
        <input className="km-colname" autoFocus value={draft} aria-label="Column name"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setDraft(col.name); setEditing(false); }
          }} />
      </div>
    );
  }

  return (
    <div className="km-colhead">
      <span className="nm">{col.name}</span>
      <span className="k-badge">{col.items.length}</span>

      {/* THE CATCH-ALL IS NOT A COLUMN and has no menu: it is where cards land
          when the column they derive into has been deleted (decision 8). It
          says what it is rather than pretending to be a lane you can rename. */}
      {!col.real && (
        <span className="lim" title="These cards derive into a column this board no longer has. Drag one anywhere, or add the column back.">
          derived
        </span>
      )}

      {col.real && (
        <span className="tools">
          {/* NAMED APART FROM A CARD'S ⋯ on purpose: `scripts/playwright/smoke.mjs`
              presses both, and two controls answering to the same
              `[aria-label^="More actions"]` would have it press one twice and
              report the other as working. */}
          <button className={`km-colbtn${open ? ' on' : ''}`} aria-label={`Column actions — ${col.name}`} onClick={onMenu}
            onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
            <KitIcon name="ellipsis" size={15} />
          </button>
        </span>
      )}

      {tip && !open && <span className="km-tip">More actions</span>}

      {open && (
        <div className="km-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button className="km-menuitem" onClick={() => { setDraft(col.name); setEditing(true); }}>Rename column</button>
          <span className="km-menusep" />
          <button className="km-menuitem" disabled={first} onClick={() => onMove(-1)}>Move column left</button>
          <button className="km-menuitem" disabled={last} onClick={() => onMove(1)}>Move column right</button>
          <span className="km-menusep" />
          {/* The cards do NOT go with it — the server clears their `list_key`
              and each lands back in its derived column. The second press is
              there because that is not obvious from the word "delete". */}
          <button className="km-menuitem danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
            {confirming ? 'Really delete? Cards return to their derived column' : 'Delete column'}
          </button>
        </div>
      )}
    </div>
  );
}

function IssueCard({
  item, selected, onSelect, dragging, onDragStart, onDragEnd,
  priOpen, onPri, onPick, menuOpen, onMenu,
  onEdit, onPark, onSignOff, onArchive, onDerive, onDelete,
}: {
  item: RoadmapItem;
  selected: boolean; onSelect: () => void;
  dragging: boolean; onDragStart: () => void; onDragEnd: () => void;
  priOpen: boolean; onPri: (e: React.MouseEvent) => void; onPick: (v: Priority) => void;
  menuOpen: boolean; onMenu: (e: React.MouseEvent) => void;
  onEdit: () => void; onPark: () => void; onSignOff: () => void;
  onArchive: () => void; onDerive: () => void; onDelete: () => void;
}) {
  const pri = bucketMeta(item.bucket);
  const held = isHeld(item);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!menuOpen) setConfirming(false); }, [menuOpen]);

  return (
    <div className={`km-card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      data-hl={item.id} onClick={onSelect}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <span className="t">{item.title}</span>

      <div className="km-cardmeta">
        {/* HELD IS THE ONE DISTINCTION WORTH AN ICON. The kit's two kinds are
            task and idea; the equivalent here is whether a human has signed the
            row off for the runner (`lib/approval.ts`), because that is the only
            thing about a card that changes what the night may do with it. */}
        <span className="kind" style={{ color: held ? 'var(--lime-500)' : 'var(--blue-400)' }}
          title={held
            ? `Held from the overnight runner — nobody has signed off this ${item.source} item`
            : 'Approved for the overnight runner'}>
          <KitIcon name={held ? 'bookmark' : 'circle-check'} size={13} />
        </span>
        <span className="id">#{item.id}</span>
        {item.estimate !== null && <span className="pts" title="Estimate, in weeks">{item.estimate}w</span>}
        {item.tier && <span className="pts" title="Desire tier — set in the item modal">{item.tier}</span>}

        <span className="right">
          <button className={`km-pri${priOpen ? ' on' : ''}`} aria-label={`Priority — ${pri.label}`}
            style={{ color: pri.color }} onClick={onPri}>
            {pri.glyph}
          </button>
          <button className={`km-colbtn${menuOpen ? ' on' : ''}`} aria-label={`More actions for #${item.id}`} onClick={onMenu}>
            <KitIcon name="ellipsis" size={15} />
          </button>
        </span>
      </div>

      {(item.area || item.claimedBy || item.skipped || item.reviewTag) && (
        <div className="km-cardtags">
          {item.area && <span className="k-tag">{item.area}</span>}
          {item.claimedBy && (
            <span className="k-tag mono" title="The branch that has claimed this item">
              <KitIcon name="git-branch" size={11} />{item.claimedBy}
            </span>
          )}
          {item.skipped && <span className="k-tag warning" title="Parked — the overnight runner skips it">parked</span>}
          {/* #263 — a verdict a machine gave SAYS SO. It is still not reversible
              from here, which is the debt named in this file's header. */}
          {item.reviewTag && (
            <span className="k-tag" title={item.verdictSource === 'auto'
              ? 'Verdict given by the auto path (#263), not by a human'
              : 'Verdict on record'}>
              {item.reviewTag}{item.verdictSource === 'auto' ? ' · auto' : ''}
            </span>
          )}
        </div>
      )}

      {priOpen && (
        <div className="km-prilist" role="menu" onClick={(e) => e.stopPropagation()}>
          <span className="cur">
            <span className="g" style={{ color: pri.color }}>{pri.glyph}</span>
            {pri.label}
          </span>
          <div className="opts">
            {BUCKETS.map((p) => {
              const on = p.value === item.bucket;
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

      {menuOpen && (
        <div className="km-menu card" role="menu" onClick={(e) => e.stopPropagation()}>
          <button className="km-menuitem" onClick={onEdit}>Edit item…</button>
          {held && (
            <button className="km-menuitem" onClick={onSignOff}
              title="Release this item to the overnight runner (#359). Only a human can.">
              Sign off for the runner
            </button>
          )}
          <button className="km-menuitem" onClick={onPark}>{item.skipped ? 'Unpark' : 'Park'}</button>
          {item.listKey && (
            <button className="km-menuitem" onClick={onDerive}
              title="Drop the stored column and let this row's own state decide again">
              Return to derived column
            </button>
          )}
          <span className="km-menusep" />
          <button className="km-menuitem" onClick={onArchive}>Archive</button>
          {/* Deleting a `hook` row TOMBSTONES its fingerprint so the next push
              cannot re-create it. That is what Dismiss means and why it has no
              undo — hence the second press. */}
          <button className="km-menuitem danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
            {confirming
              ? (item.source === 'hook' ? 'Really delete? The next push will not re-add it' : 'Really delete?')
              : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({ onClose, onAdd }: { onClose: () => void; onAdd: (text: string, bucket: Priority) => void }) {
  const [text, setText] = useState('');
  const [bucket, setBucket] = useState<Priority>('should');
  const [pick, setPick] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { const t = text.trim(); if (t) onAdd(t, bucket); else onClose(); };
  const meta = bucketMeta(bucket);
  return (
    <div className="km-composer" onClick={(e) => e.stopPropagation()}>
      <textarea ref={ref} rows={2} value={text} placeholder="What needs to be done?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }} />
      <div className="km-composer-foot">
        <button className="ic" aria-label={`Priority — ${meta.label}`} style={{ color: meta.color }}
          onClick={() => setPick(!pick)}>
          {meta.glyph}<span className="chev">▾</span>
        </button>
        {pick && (
          <span className="km-composer-pick">
            {BUCKETS.map((p) => (
              <button key={p.value} className={p.value === bucket ? 'on' : ''} style={{ color: p.color }}
                onClick={() => { setBucket(p.value); setPick(false); }}>{p.label}</button>
            ))}
          </span>
        )}
        <button className={`go${text.trim() ? ' armed' : ''}`} aria-label="Add item" onClick={submit}>
          {'⏎'}
        </button>
      </div>
    </div>
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const commit = () => { const n = name.trim(); setOpen(false); setName(''); if (n) onAdd(n); };
  if (!open) {
    return (
      <button className="km-addcol" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <KitIcon name="plus" size={14} />Add column
      </button>
    );
  }
  return (
    <div className="km-addcol open" onClick={(e) => e.stopPropagation()}>
      <input className="km-colname" autoFocus value={name} placeholder="Column name" aria-label="New column name"
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setOpen(false); setName(''); }
        }} />
    </div>
  );
}

// The item modal is the other way in, and it is the one that can set a tier, a
// risk, an area and a plan. This dialog is the FAST way — a title and how
// necessary it is — so it deliberately asks for nothing else.
function CreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, bucket: Priority) => void }) {
  const [title, setTitle] = useState('');
  const [bucket, setBucket] = useState<Priority>('should');
  const submit = () => { const t = title.trim(); if (t) onCreate(t, bucket); };
  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="km-dialog-head">
          <span className="t">Create issue</span>
          <span className="d">It lands in To Do, in this bucket, at the end of the queue.</span>
        </div>
        <label className="km-field">
          <span className="lbl">Summary</span>
          <span className="searchbox km-input">
            <input autoFocus placeholder="Short, imperative" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </span>
        </label>
        <label className="km-field">
          <span className="lbl">Priority</span>
          <select className="km-select" value={bucket} onChange={(e) => setBucket(e.target.value as Priority)}>
            {BUCKETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <div className="km-dialog-foot">
          <button className="k-btn ghost" onClick={onClose}>Cancel</button>
          <button className="k-btn" onClick={submit} disabled={!title.trim()}>Create</button>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   THE TWO TABS BELOW ARE STILL MOCKUPS — everything from here down reads
   nothing and writes nothing. `PriorityKey` and `PRIORITIES` are the KIT's five
   priorities, kept alive for them alone: the wired board above uses `BUCKETS`,
   which is what this app actually stores.
   ========================================================================== */

type PriorityKey = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

const PRIORITIES: { value: PriorityKey; label: string; glyph: string; color: string }[] = [
  { value: 'highest', label: 'Highest', glyph: '⌃⌃', color: 'var(--status-danger-fg)' },
  { value: 'high', label: 'High', glyph: '⌃', color: 'var(--status-danger-fg)' },
  { value: 'medium', label: 'Medium', glyph: '=', color: 'var(--amber-500)' },
  { value: 'low', label: 'Low', glyph: '⌄', color: 'var(--blue-400)' },
  { value: 'lowest', label: 'Lowest', glyph: '⌄⌄', color: 'var(--blue-400)' },
];

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
