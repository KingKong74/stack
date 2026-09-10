// THE ROADMAP TAB IS THE IDEA SURFACE, and it is wired (#472).
//
// It draws exactly the rows the BOARD deliberately does not, and `isIdea` in
// lib/plan.ts is the one line between the two screens — read its header before
// touching either. Two populations land here:
//
//  • HELD rows NOBODY HAS WORKED — `hook` (the extractor read one off a push)
//    and `fly` (a live session opened one for its own work) that nobody has
//    signed off. They used to appear on the board, where an auto-extraction sat
//    among committed work looking exactly like it. They arrive here now, which
//    is the whole of what the owner asked for: an idea is not work until
//    somebody says it is.
//  • CHILD rows (`parent_id`) — an idea filed under something already on the
//    board. The other half of the ask: see what you are working on, and add to
//    it without turning every thought into a card the runner might pick up.
//
// WORK LEAVES THIS SCREEN THE MOMENT IT IS WORKED, sign-off or no sign-off. A
// held row a session has CLAIMED or BUILT is committed work by the only evidence
// that matters — somebody did it — so it is drawn on the board and the hold is
// said and answered there (`isIdea`'s header carries why). Without that, a
// session's own card sat here through the whole night that built it, and the
// owner had to Promote their own instruction to get it onto the board.
//
// PROMOTING IS ONE WRITE WITH ONE MEANING: `reviewed: true` plus
// `parentId: null`, together saying "this is committed work now". Nothing else
// moves a row between the two screens, and a held row and a child both leave by
// the same door.
//
// FOUR DECISIONS WORTH THE INK:
//
//  1. THE THREE COLUMNS ARE `bucket` AND `skipped`. Ready = highest or high,
//     Thinking = medium, low or lowest, Parked = `skipped`, and dragging an
//     idea between the first two writes its priority.
//
//     THIS COLUMN USED TO BE `tier`, THE DESIRE RANK (#227), and #477 retired
//     that column outright: what the machine works next is the order of the
//     SPRINT it was dragged into, on the board's Backlog tab, and a second
//     ranking living here would have been a rival answer to the same question.
//     The split survives the change because the question it asks survives it —
//     "is this worth doing" is what triage is for, and it is the question
//     `bucket` has always answered. What it no longer does is decide what runs
//     tonight: an idea is not runnable at all until somebody promotes it AND
//     puts it in a sprint, so the Ready column is a recommendation now rather
//     than a queue position, which is the honest thing for a triage screen to
//     be.
//  2. THERE IS NO FREE-FLOATING CAPTURE, and that is not an omission. A manual
//     row is NEVER held (CLAUDE.md — blocking hand-written work is the failure
//     mode approval must not have), so a hand-typed row with no parent is
//     committed work by definition and belongs on the board, where the
//     composer and the create dialog already put it. Capture here always hangs
//     off something: press ＋ on a board item and the idea is born under it.
//  3. AN AREA IS A LANE, so this screen says so in the same words the board
//     does — `(project, area)` admits one overnight worker (#267), each section
//     header names the branch holding its lane, and untagged says it can never
//     hold one. Two screens agreeing about what an area IS matters more here
//     than on the board, because this is where a row gets filed into one.
//  4. DISCARD IS DELETE, and on a `hook` row it TOMBSTONES THE FINGERPRINT so
//     the next push cannot re-create it. That is what Dismiss has always meant
//     and why it has no undo; the second press is because the word does not say
//     it on its own.
//
// WHAT THIS SCREEN STILL CANNOT DO: give a verdict. #263's third leg — a
// machine verdict must be readable by the human it stands in for — is unmet
// across the whole app, and a verdicted row is board work, so it is not this
// screen's to fix. Board.tsx's header carries the debt.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import type { BoardArea, Priority, RoadmapItem } from '../types';
import { PRIORITY_META, PRIORITY_DEFAULT, priorityMeta } from '../lib/ui';
import { isIdea } from '../lib/plan';
import { isHeld } from '../lib/approval';
import {
  getBoardShape, createRoadmapItem, patchRoadmapItem, deleteRoadmapItem,
} from '../store';

// Same key, same reason, as the board's: untagged is a REAL scope and never a
// lane (#267). The leading space keeps it off any area an owner could type.
const UNTAGGED = ' untagged';

type Col = 'ready' | 'thinking' | 'parked';
const COLS: { key: Col; label: string }[] = [
  { key: 'ready', label: 'Ready' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'parked', label: 'Parked' },
];

/** The two priorities that read as "worth doing" — the Ready column. They are
 *  the same two the overnight runner used to gate on before #477 made sprint
 *  membership the gate instead, which is not a coincidence: this is where that
 *  judgement went once it stopped being a run condition. */
const READY: Priority[] = ['highest', 'high'];

/** Which of the three an idea sits in. `skipped` outranks the priority: a
 *  parked row is parked whatever you once thought of it. */
const colOf = (it: RoadmapItem): Col =>
  (it.skipped ? 'parked' : READY.includes(it.bucket) ? 'ready' : 'thinking');

/** Where an idea came from, in one word. `manual` on a CHILD means somebody
 *  typed it here, which is the only way a manual row reaches this screen. */
const sourceOf = (it: RoadmapItem): string =>
  (it.source === 'hook' ? 'auto' : it.source === 'fly' ? (it.flySession || 'session') : 'filed');

export function Roadmap({ slug, projectName, items, onRefresh, onEdit, highlightId }: {
  slug: string;
  projectName: string;
  /** The project payload's own roadmap, flattened and in payload order. */
  items: RoadmapItem[];
  onRefresh: () => void;
  /** Open the item modal — note, title, area, sub-area and plan. */
  onEdit: (it: RoadmapItem) => void;
  highlightId: string | null;
}) {
  const [rows, setRows] = useState<RoadmapItem[]>(items);
  useEffect(() => { setRows(items); }, [items]);

  const [areas, setAreas] = useState<BoardArea[]>([]);
  const [err, setErr] = useState('');

  // Only the AREAS are fetched — this screen has no columns of its own, so the
  // board's list table is none of its business.
  const loadShape = useCallback(async () => {
    setAreas((await getBoardShape(slug)).areas);
  }, [slug]);
  useEffect(() => {
    let live = true;
    loadShape().catch(() => { /* an unregistered area still groups; see areaKey */ });
    return () => { live = false; void live; };
  }, [loadShape]);

  const guard = async (fn: () => Promise<void>) => {
    try { setErr(''); await fn(); }
    catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); }
  };
  const wrote = (updated: RoadmapItem) => {
    setRows((r) => r.map((x) => (x.id === updated.id ? updated : x)));
    onRefresh();
  };

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const areaKey = (it: RoadmapItem) => it.area.trim() || UNTAGGED;

  const matches = (it: RoadmapItem) => {
    const needle = query.trim().toLowerCase();
    return !needle
      || it.title.toLowerCase().includes(needle)
      || it.note.toLowerCase().includes(needle)
      || String(it.id) === needle.replace(/^#/, '');
  };

  // The two populations, off the same rows and by the same predicate the board
  // filters with, so nothing can be on both screens or on neither.
  const ideas = useMemo(
    () => rows.filter((it) => !it.archived && isIdea(it) && matches(it)),
    [rows, query]);
  const onBoard = useMemo(
    () => rows.filter((it) => !it.archived && !it.done && !isIdea(it)),
    [rows]);

  const parentOf = useMemo(() => {
    const m = new Map<number, RoadmapItem>();
    for (const it of rows) m.set(it.id, it);
    return m;
  }, [rows]);

  const sections = useMemo(() => {
    const byArea = new Map<string, RoadmapItem[]>();
    for (const it of ideas) {
      const k = areaKey(it);
      const bag = byArea.get(k);
      if (bag) bag.push(it); else byArea.set(k, [it]);
    }
    // An area with NO ideas but work on the board is still a section: it is
    // where you go to file the first idea under that work, and hiding it would
    // make ＋ reachable only for areas that already had one.
    const boardByArea = new Map<string, RoadmapItem[]>();
    for (const it of onBoard) {
      const k = areaKey(it);
      const bag = boardByArea.get(k);
      if (bag) bag.push(it); else boardByArea.set(k, [it]);
    }

    const order = [...areas.map((a) => a.name)];
    for (const k of [...byArea.keys(), ...boardByArea.keys()]) {
      if (k !== UNTAGGED && !order.includes(k)) order.push(k);
    }
    if (byArea.has(UNTAGGED) || boardByArea.has(UNTAGGED)) order.push(UNTAGGED);

    return order
      .filter((k) => byArea.has(k) || boardByArea.has(k))
      .filter((k) => (scope ? k === scope : true))
      .map((k) => {
        const mine = byArea.get(k) || [];
        const work = boardByArea.get(k) || [];
        const holder = k === UNTAGGED
          ? null
          : (work.find((it) => it.claimedBy.trim())?.claimedBy || null);
        return {
          key: k,
          name: k === UNTAGGED ? 'No area' : k,
          dot: areas.find((a) => a.name === k)?.dot || '',
          untagged: k === UNTAGGED,
          holder,
          work,
          count: mine.length,
          cols: COLS.map((c) => ({ ...c, items: mine.filter((it) => colOf(it) === c.key) })),
        };
      });
  }, [ideas, onBoard, areas, scope]);

  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of ideas) counts.set(areaKey(it), (counts.get(areaKey(it)) || 0) + 1);
    for (const it of onBoard) if (!counts.has(areaKey(it))) counts.set(areaKey(it), 0);
    const order = [...areas.map((a) => a.name)];
    for (const k of counts.keys()) if (k !== UNTAGGED && !order.includes(k)) order.push(k);
    const out = order.filter((k) => counts.has(k)).map((k) => ({
      key: k, name: k, dot: areas.find((a) => a.name === k)?.dot || '', n: counts.get(k) || 0,
    }));
    if (counts.has(UNTAGGED)) out.push({ key: UNTAGGED, name: 'No area', dot: '', n: counts.get(UNTAGGED) || 0 });
    return out;
  }, [ideas, onBoard, areas]);

  // ---- writes ---------------------------------------------------------------

  // ONE WRITE, ONE MEANING. `reviewed` releases a held row to the runner
  // (#359); `parentId: null` detaches a child. Together they say the row is
  // committed work, and it is on the board on the next render.
  const promote = (it: RoadmapItem) =>
    guard(async () => {
      wrote(await patchRoadmapItem(slug, it.id, { reviewed: true, parentId: null }));
    });
  const setBucket = (it: RoadmapItem, bucket: Priority) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { bucket })); });
  const park = (it: RoadmapItem) =>
    guard(async () => { wrote(await patchRoadmapItem(slug, it.id, { skipped: !it.skipped })); });
  const discard = (it: RoadmapItem) =>
    guard(async () => {
      await deleteRoadmapItem(slug, it.id);
      setRows((r) => r.filter((x) => x.id !== it.id));
      onRefresh();
    });
  // Born UNDER something, which is what keeps it on this screen: a manual row
  // with no parent is committed work and belongs on the board (decision 2).
  const addIdea = (parent: RoadmapItem, title: string) =>
    guard(async () => {
      const made = await createRoadmapItem(slug, {
        title, note: '', bucket: PRIORITY_DEFAULT,
        ...(parent.area ? { area: parent.area } : {}),
      });
      const child = await patchRoadmapItem(slug, made.id, { parentId: parent.id });
      setRows((r) => [...r, child]);
      onRefresh();
    });

  const [open, setOpen] = useState<number | null>(null);
  const [composeUnder, setComposeUnder] = useState<number | null>(null);

  useEffect(() => {
    const n = Number(highlightId);
    if (Number.isFinite(n) && n > 0) setOpen(n);
  }, [highlightId]);

  // THE LEDE SAYS "IN THIS SCOPE", so both of its numbers have to be. They were
  // read off the unscoped list, which made the sentence false the moment a chip
  // was pressed — the sections narrowed and the count sat still. The smoke
  // caught it as `control-inert`, which was the honest reading: from outside,
  // a press that changes no number IS a control that did nothing.
  //
  // `total` stays unscoped on purpose — it is the "All areas" chip's count, and
  // a chip that counted only what is already showing would always read the same
  // as the lede beside it.
  const total = rows.filter((it) => !it.archived && isIdea(it)).length;
  const scoped = useMemo(
    () => (scope ? ideas.filter((it) => areaKey(it) === scope) : ideas),
    [ideas, scope]);
  const ready = scoped.filter((it) => colOf(it) === 'ready').length;

  return (
    <div className="im">
      <div className="im-head">
        <div className="im-title">
          <span className="eyebrow">{projectName}</span>
          <h1>Roadmap</h1>
        </div>
        <span className="im-lede">
          {scoped.length} idea{scoped.length === 1 ? '' : 's'} · {ready} ready in this scope
        </span>
      </div>

      {err && <div className="km-err" role="alert">{err}</div>}

      <div className="im-bar">
        <AreaChip label="All areas" count={total} active={scope === ''} onClick={() => setScope('')} />
        {chips.length > 0 && <span className="im-chipsep" />}
        {chips.map((c) => (
          <AreaChip key={c.key} label={c.name} dot={c.dot} count={c.n}
            active={scope === c.key} onClick={() => setScope(c.key)} />
        ))}
        <span className="searchbox sm im-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search ideas" aria-label="Search ideas" value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </span>
      </div>

      <div className="im-sections">
        {sections.map((sec) => (
          <section className="im-section" key={sec.key}>
            <div className="im-sechead">
              <span className={`ico${sec.untagged ? ' global' : ''}`}>
                <KitIcon name={sec.untagged ? 'layers' : 'layout-grid'} size={13} />
              </span>
              {sec.dot && <span className="km-dot" style={{ background: sec.dot }} />}
              <span className="nm">{sec.name}</span>
              <span className="scope">
                {sec.untagged
                  ? 'Never a lane — untagged work neither holds one nor waits on one'
                  : sec.holder
                    ? `Lane held by ${sec.holder} — no second worker until it lands`
                    : 'Lane free'}
              </span>
              <span className="n">{sec.count} {sec.count === 1 ? 'idea' : 'ideas'}</span>
            </div>

            {/* ON THE BOARD — this area's committed work, and the only way to
                file an idea. Pressing ＋ opens a composer whose row is born
                under that item, which is what keeps it on this screen. */}
            {sec.work.length > 0 && (
              <div className="rm-under">
                <span className="lbl">On the board</span>
                {sec.work.map((w) => (
                  <span key={w.id} className={`rm-work${composeUnder === w.id ? ' on' : ''}`}>
                    <button className="t" title={w.note || w.title}
                      onClick={() => setComposeUnder(composeUnder === w.id ? null : w.id)}>
                      {w.claimedBy.trim() && <KitIcon name="git-branch" size={11} />}
                      <span className="v">{w.title}</span>
                      <span className="n">{rows.filter((x) => x.parentId === w.id && !x.archived).length}</span>
                    </button>
                    <button className="add" aria-label={`Add an idea under ${w.title}`}
                      title={`Add an idea under "${w.title}"`}
                      onClick={() => setComposeUnder(composeUnder === w.id ? null : w.id)}>
                      <KitIcon name="plus" size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {composeUnder !== null && sec.work.some((w) => w.id === composeUnder) && (
              <IdeaComposer parent={parentOf.get(composeUnder)!}
                onClose={() => setComposeUnder(null)}
                onAdd={(text) => {
                  const p = parentOf.get(composeUnder);
                  setComposeUnder(null);
                  if (p) addIdea(p, text);
                }} />
            )}

            <div className="im-cols">
              {sec.cols.map((col) => (
                <div className="im-col" key={col.key}>
                  <div className="im-colhead">
                    <span className={`lbl${col.key === 'ready' ? ' ready' : ''}`}>{col.label}</span>
                    <span className="n">{col.items.length}</span>
                  </div>
                  {col.items.length ? col.items.map((it) => (
                    <IdeaCard key={it.id} idea={it}
                      parent={it.parentId === null ? null : parentOf.get(it.parentId) || null}
                      open={open === it.id}
                      onToggle={() => setOpen(open === it.id ? null : it.id)}
                      onPromote={() => promote(it)}
                      onBucket={(b) => setBucket(it, b)}
                      onPark={() => park(it)}
                      onEdit={() => onEdit(it)}
                      onDiscard={() => discard(it)} />
                  )) : (
                    <span className="im-empty">Nothing here</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {sections.length === 0 && (
          <span className="im-empty">
            {query.trim()
              ? 'No idea matches that.'
              : 'No ideas yet. A push files them here automatically, and ＋ on a board item adds one by hand.'}
          </span>
        )}
      </div>
    </div>
  );
}

function AreaChip({ label, dot, count, active, onClick }: {
  label: string; dot?: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button className={`im-chip${active ? ' on' : ''}`} onClick={onClick} aria-pressed={active}>
      {dot && <span className="km-dot" style={{ background: dot }} />}
      {label}
      <span className="n">{count}</span>
    </button>
  );
}

function IdeaComposer({ parent, onClose, onAdd }: {
  parent: RoadmapItem; onClose: () => void; onAdd: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { const t = text.trim(); if (t) onAdd(t); else onClose(); };
  return (
    <div className="km-composer rm-composer">
      <span className="rm-under-lbl">An idea under <b>{parent.title}</b></span>
      <textarea ref={ref} rows={2} value={text} placeholder="What would you add to it?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }} />
      <div className="km-composer-foot">
        <button className={`go${text.trim() ? ' armed' : ''}`} aria-label="Add idea" onClick={submit}>
          {'⏎'}
        </button>
      </div>
    </div>
  );
}

function IdeaCard({ idea, parent, open, onToggle, onPromote, onBucket, onPark, onEdit, onDiscard }: {
  idea: RoadmapItem; parent: RoadmapItem | null; open: boolean; onToggle: () => void;
  onPromote: () => void; onBucket: (b: Priority) => void; onPark: () => void;
  onEdit: () => void; onDiscard: () => void;
}) {
  const ready = colOf(idea) === 'ready';
  const held = isHeld(idea);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open) setConfirming(false); }, [open]);

  return (
    <div className={`im-card${open ? ' open' : ''}${ready ? ' ready' : ''}`}
      data-hl={idea.id} onClick={onToggle}>
      <div className="im-cardtop">
        <span className="mark" style={ready ? { color: 'var(--lime-500)' } : undefined}>
          <KitIcon name="bookmark" size={14} />
        </span>
        <span className="t">{idea.title}</span>
        <span className="eff" style={{ color: priorityMeta(idea.bucket).color }}
          title={`Priority — ${priorityMeta(idea.bucket).label}`}>{priorityMeta(idea.bucket).glyph}</span>
      </div>

      {idea.note.trim() && <span className={`im-note${open ? '' : ' clamp'}`}>{idea.note}</span>}

      <div className="im-meta">
        <span className="k-tag mono">#{idea.id}</span>
        <span className="k-tag" title={held
          ? 'Nobody has signed this off, so the overnight runner leaves it alone (#359)'
          : 'Filed by hand under a board item'}>{sourceOf(idea)}</span>
        {parent && (
          <span className="k-tag" title={`An idea under "${parent.title}" (#${parent.id})`}>
            under #{parent.id}
          </span>
        )}
        {idea.skipped && <span className="k-tag warning">parked</span>}
      </div>

      {open && (
        <div className="im-acts" onClick={(e) => e.stopPropagation()}>
          {/* HOW NECESSARY, which is what this screen is triaging — and it is
              deliberately NOT a claim about what runs next. Nothing here is
              runnable until it is promoted onto the board AND dragged into a
              sprint (#477); the top two priorities are what moves an idea into
              Ready, and that is a recommendation to the person filling the next
              sprint rather than a queue position. */}
          <div className="rm-tier" role="tablist" aria-label="How necessary this is">
            <span className="lbl">Worth doing</span>
            {PRIORITY_META.map((p) => (
              // THE SELECTED OPTION IS NOT TINTED, and the palette audit is
              // why. `.opt.on` already fills with the accent, so painting the
              // priority's own colour on top put a red glyph on a blue fill at
              // 2.56:1 — well under AA, and invisible to the smoke, which
              // measures layout and not tone. Selection is carried by the fill;
              // the priority's COLOUR lives on the card's own chip above,
              // where it sits on a ground it contrasts with.
              <button key={p.key} type="button" role="tab" aria-selected={idea.bucket === p.key}
                className={`opt${idea.bucket === p.key ? ' on' : ''}`}
                title={`${p.label}${READY.includes(p.key) ? ' — sits in Ready' : ' — sits in Thinking'}`}
                onClick={() => onBucket(p.key)}>{p.glyph}</button>
            ))}
          </div>

          <span className="from">
            {held
              ? `Opened by ${sourceOf(idea)}, not worked yet, and held out of the overnight runner until you promote it.`
              : parent
                ? `Filed under "${parent.title}". Promoting detaches it and puts it on the board.`
                : 'Promoting puts this on the board.'}
          </span>

          <div className="btns">
            <button className={`k-btn sm ${ready ? 'accent' : 'secondary'}`} onClick={onPromote}>
              <KitIcon name="arrow-up-right" size={13} />Promote to board
            </button>
            <button className="k-btn sm ghost" onClick={onPark}>
              <KitIcon name="layers" size={13} />{idea.skipped ? 'Unpark' : 'Park'}
            </button>
            <button className="k-btn sm ghost" onClick={onEdit}>
              <KitIcon name="pencil" size={13} />Edit…
            </button>
            {/* On a `hook` row this TOMBSTONES the fingerprint, so the next push
                cannot bring it back. That is what Dismiss means and why the
                word alone is not enough of a warning. */}
            <button className="k-btn sm danger" onClick={() => (confirming ? onDiscard() : setConfirming(true))}>
              <KitIcon name="trash-2" size={13} />
              {confirming
                ? (idea.source === 'hook' ? 'Really? The next push will not re-add it' : 'Really discard?')
                : 'Discard'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
