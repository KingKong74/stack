import { useState } from 'react';
import type { RoadmapItem, Roadmap as RoadmapData } from '../types';
import { tierRank } from '../types';
import { isApproved } from '../lib/approval';
import { labelsOf } from '../lib/labels';
import { timeAgo } from '../lib/ui';

// THE ROADMAP TAB — the kit's IdeasScreen, on Stack's own rows.
//
// "Rough notes stay here until they earn a branch." That sentence is the whole
// boundary between this tab and the board beside it, and it is why this is not
// a second board over one table (which CLAUDE.md forbids, and rightly): the
// board is work IN FLIGHT — claimed, building, shipped, verdicted — and this is
// everything that has not started. An item leaves this tab the moment it takes
// a branch claim, and it never comes back, because from then on the board is
// the thing that knows where it is.
//
// THE THREE COLUMNS ARE READ OFF COLUMNS THAT ALREADY MEAN THIS. Nothing new is
// stored and nothing here writes a tier:
//
//   Parked   — `skipped`. An exact match: Stack's park is already "cut from
//              this cycle, still part of the feature", which is what the kit's
//              Parked column says in words.
//   Ready    — has a TIER (#227). The tier is how much the owner wants it NEXT
//              and is the run queue's primary sort, so a tiered item is by
//              definition the one ready to earn a branch.
//   Thinking — no tier, or still held. Captured and not yet ranked.
//
// THE SCREEN IS THE KIT'S IdeasScreen (#443): an eyebrow and a title over one
// toolbar row — search, what the board holds, and the one button that adds to
// it — then the three columns. The SEARCH only narrows what is drawn (never
// writes, never reorders), and it says how many of how many it is showing,
// because a shelf quietly displaying six of thirty is the same silence as a
// NULL verdict. CAPTURE IDEA opens the same item modal ＋ opens: this tab is
// the shelf those rows land on, so the way to add one belongs on it.
//
// A HELD ITEM IS SHOWN AND SAYS SO. The first cut of this file excluded rows
// awaiting sign-off on the grounds that For you → Auto-ideas is their inbox —
// and on a project whose every open item was `fly`-filed that drew an EMPTY
// roadmap over four real items. An item that exists and appears on no screen is
// a lie of omission, so a held row sits in Thinking (which is exactly what it
// is: captured, not yet signed off) wearing a HELD chip, and carries the one
// action that moves it on. Auto-ideas is still the queue you work THROUGH; this
// is the shelf you look AT. Dismiss stays there alone — deleting a row is not
// something to offer twice.

type Col = { key: string; label: string; note: string; items: RoadmapItem[] };

const bucketRank: Record<string, number> = { must: 0, should: 1, could: 2, wont: 3 };

function order(a: RoadmapItem, b: RoadmapItem): number {
  const t = tierRank(a.tier) - tierRank(b.tier);
  if (t) return t;
  const k = (bucketRank[a.bucket] ?? 9) - (bucketRank[b.bucket] ?? 9);
  if (k) return k;
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

export function Ideas({ roadmap, labels, onOpen, onPark, onDelete, onKeep, onCapture }: {
  roadmap: RoadmapData;
  labels: { key: string; name: string; tone: string }[];
  onOpen: (it: RoadmapItem) => void;
  onPark: (it: RoadmapItem, parked: boolean) => void;
  onDelete: (it: RoadmapItem) => void;
  onKeep: (it: RoadmapItem) => void;
  /** Open the item modal on a blank row. Absent = the button is not offered. */
  onCapture?: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  const all = [...roadmap.must, ...roadmap.should, ...roadmap.could, ...roadmap.wont];
  // Kept, unstarted work. `claimedBy` is the line: a claim means it earned its
  // branch and the board owns it from here.
  const capture = all.filter((i) => !i.done && !i.claimedBy);
  // The search reads the words, the number and the note — the three things you
  // might arrive knowing about a row you half-remember writing.
  const q = query.trim().toLowerCase();
  const shown = !q ? capture : capture.filter((i) =>
    i.title.toLowerCase().includes(q)
    || i.note.toLowerCase().includes(q)
    || (i.area || '').toLowerCase().includes(q)
    || `#${i.id}`.includes(q.startsWith('#') ? q : `#${q}`));
  const cols: Col[] = [
    {
      key: 'ready', label: 'Ready', note: 'ranked — the runner picks from here',
      // Ready means the runner may actually pick it up, so a held row is never
      // ready however it is tiered — that is the whole point of the hold.
      items: shown.filter((i) => !i.skipped && i.tier && isApproved(i)).sort(order),
    },
    {
      key: 'thinking', label: 'Thinking', note: 'kept, not yet ranked',
      items: shown.filter((i) => !i.skipped && (!i.tier || !isApproved(i))).sort(order),
    },
    {
      key: 'parked', label: 'Parked', note: 'cut from this cycle, still on the books',
      items: shown.filter((i) => i.skipped).sort(order),
    },
  ];

  // The counts read off the WHOLE shelf, never the search: "6 ready" that drops
  // to 1 because you typed three letters is a different and wrong answer.
  const ready = capture.filter((i) => !i.skipped && i.tier && isApproved(i)).length;

  return (
    <div className="ideas">
      <div className="ideas-head">
        <div className="ideas-title">
          <span className="eyebrow">Workspace</span>
          <h2>Roadmap</h2>
        </div>
        <div className="ideas-lede">
          Rough notes stay here until they earn a branch. An item leaves this tab the moment it
          takes a claim — from then on the board knows where it is.
        </div>
      </div>

      <div className="ideas-bar">
        <span className="searchbox sm ideas-search">
          <span className="glass" aria-hidden="true" />
          <input type="search" value={query} placeholder="Search ideas"
            aria-label="Search these ideas by title, number, note or area"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} />
        </span>
        <span className="ideas-count">
          {capture.length} captured · {ready} ready to pick up
        </span>
        {/* Hidden at zero: "11 of 11 shown" is furniture. */}
        {q && (
          <button className="ideas-searchnote" onClick={() => setQuery('')}
            title="Clear the search and show the whole shelf">
            {cols.reduce((n, c) => n + c.items.length, 0)} of {capture.length} shown ×
          </button>
        )}
        {onCapture && (
          <button className="k-btn sm secondary ideas-capture" onClick={onCapture}
            title="Open a new item — it lands here until it earns a branch">
            {/* A plain ASCII plus. The fullwidth ＋ the ＋ dock wears is a
                tofu box in a headless browser with no CJK font, and this
                file's own header already carries that lesson once. */}
            + Capture idea
          </button>
        )}
      </div>

      <div className="ideas-cols">
        {cols.map((col) => (
          <div className="ideas-col" key={col.key}>
            <div className="ideas-colhead">
              <span className={`lbl ${col.key}`}>{col.label}</span>
              <span className="n">{col.items.length}</span>
              <span className="note">{col.note}</span>
            </div>

            {/* Two kinds of empty, and they are not the same answer: a column
                with nothing in it, and a column with nothing MATCHING. */}
            {col.items.length === 0 && (
              <div className="ideas-empty">
                {q ? `Nothing ${col.label.toLowerCase()} matches “${query.trim()}”.` : `Nothing ${col.label.toLowerCase()}.`}
              </div>
            )}

            {col.items.map((it) => (
              <IdeaCard key={it.id} item={it} labels={labels} ready={col.key === 'ready'}
                open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)}
                onOpen={onOpen} onPark={onPark} onDelete={onDelete} onKeep={onKeep} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function IdeaCard({ item, labels, ready, open, onToggle, onOpen, onPark, onDelete, onKeep }: {
  item: RoadmapItem;
  labels: { key: string; name: string; tone: string }[];
  ready: boolean; open: boolean; onToggle: () => void;
  onOpen: (it: RoadmapItem) => void;
  onPark: (it: RoadmapItem, parked: boolean) => void;
  onDelete: (it: RoadmapItem) => void;
  onKeep: (it: RoadmapItem) => void;
}) {
  const mine = labelsOf(item.labels, labels);
  const held = !isApproved(item);
  // Where it came from, in the words of the thing that filed it. A card that
  // cannot say this is one you have to remember writing.
  const from = item.source === 'hook' ? 'extracted from a push'
    : item.source === 'fly' ? `opened by ${item.flySession || 'a live session'}`
      : 'captured by hand';

  return (
    <div className={`idea${open ? ' open' : ''}${ready ? ' ready' : ''}${item.skipped ? ' parked' : ''}`}
      onClick={onToggle}>
      <div className="idea-top">
        {/* One glyph for every card. A pause sign for the parked ones was the
            obvious idea and it rendered as a tofu box in a plain headless
            browser — the dashed border and the column it sits under already
            say parked, in a font every machine has. */}
        <span className="mark" aria-hidden="true">✦</span>
        <span className="t">{item.title}</span>
        {item.estimate != null && <span className="est">{item.estimate}w</span>}
      </div>

      {item.note && <p className={`idea-note${open ? '' : ' clamp'}`}>{item.note}</p>}

      <div className="idea-meta">
        <span className="k-tag mono id">#{item.id}</span>
        {held && (
          <span className="held" title="Held from the overnight runner until you keep it — its queue is For you → Auto-ideas">
            held
          </span>
        )}
        {item.tier && <span className={`rp-tier t${item.tier}`}>{item.tier}</span>}
        <span className="bucket">{item.bucket}</span>
        {item.area && <span className="area">{item.area}</span>}
        {mine.map((l) => <span key={l.key} className={`rl rl-${l.tone} on`}>{l.name}</span>)}
        <span className="age">{timeAgo(item.updatedAt)}</span>
      </div>

      {open && (
        <div className="idea-acts" onClick={(e) => e.stopPropagation()}>
          <span className="from">{from}</span>
          {/* The kit's Button, in its four weights, and the order is the
              judgement: the one thing this card is FOR carries the accent
              (Keep on a held row, Open on a kept one), and the destructive one
              is a tinted outline rather than a filled red — a delete that
              shouts louder than the primary action teaches the eye to skip
              both. */}
          {held && (
            <button className="k-btn sm accent" onClick={() => onKeep(item)}
              title="Keep — signs it off, and the overnight runner may pick it up">
              ✓ Keep
            </button>
          )}
          <button className={`k-btn sm ${held ? 'secondary' : 'accent'}`} onClick={() => onOpen(item)}>Open</button>
          <button className="k-btn sm ghost" onClick={() => onPark(item, !item.skipped)}
            title={item.skipped
              ? 'Unpark — back into this cycle, and back in front of the runner'
              : 'Park — cut from this cycle, still part of the feature and still on the books'}>
            {item.skipped ? 'Unpark' : 'Park'}
          </button>
          <button className="k-btn sm danger" onClick={() => onDelete(item)}
            title="Delete this item — not the same as parking it">Delete</button>
        </div>
      )}
    </div>
  );
}
