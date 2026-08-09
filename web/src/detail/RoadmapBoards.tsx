// The Plan view's other two boards — TIERS and PARKED.
//
// Both used to be top-level views of their own, driven by the old `Roadmap`
// component. They are boards, they read the same rows the Plan board reads, and
// a tab strip whose first three entries were the plan and whose last two were
// two more readings of it made the tab look like five unrelated screens. They
// are now boards inside Plan, switched beside Lists.
//
// THE TIER BOARD IS WHERE `tier` IS SET, AND IT IS THE ONLY PLACE. `tier` (#227,
// S/A/B/C, NULL = unranked) is the PRIMARY SORT of the run queue — how much the
// owner wants a thing NEXT, as against `bucket`, which is how necessary it is.
// CLAUDE.md's rule is unchanged by the move: agents must never write it, and it
// is set from here by a human dragging a card. Retiring the old view without
// carrying this would have removed the owner's only control over what the fleet
// picks up first.
//
// A COLUMN IS STILL NOT A VERDICT, the same rule the Lists board holds: dropping
// a card in a tier changes what you want built next and nothing else.
//
// THE PARKED BOARD KEEPS ITS AGES (#247). A parked item's whole problem is that
// it is easy to forget, so the shelf reports how long each has sat and flags the
// ones past the owner's stale threshold. Rows park with no `skippedAt` from
// before that column existed; those read "parked" with no age rather than as
// parked today — absent is not zero, the same rule as everywhere else.

import type { BoardArea, Priority, RoadmapItem, Tier } from '../types';
import { TIERS } from '../types';
import { labelsOf } from '../lib/labels';
import { inCycle } from '../lib/plan';

const TIER_META: Record<string, string> = {
  S: 'next, whatever else is open', A: 'soon', B: 'after the above', C: 'someday',
};
// Built from TIERS so the set of ranks has one definition, with unranked
// appended LAST — which is where `tierRank` sorts it, not a fifth rank.
const TIER_COLS: { key: Tier; name: string; meta: string }[] = [
  ...TIERS.map((t) => ({ key: t as Tier, name: t, meta: TIER_META[t] })),
  { key: '' as Tier, name: 'Unranked', meta: 'sorts last — reached only when the rest is clear' },
];

const BUCKET_LABEL: Record<Priority, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't",
};
const PARK_COLS: Priority[] = ['must', 'should', 'could', 'wont'];

export interface BoardsProps {
  items: RoadmapItem[];
  areas: BoardArea[];
  areaFilter: string;
  /** #247 — days a parked item may sit before the shelf calls it stale. */
  staleItemDays?: number;
  onSetTier: (item: RoadmapItem, tier: Tier) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  onOpen: (item: RoadmapItem) => void;
  /** The ✧ board cleanup op — Tiers only, where it has always lived. */
  onCleanup?: () => void;
  onSendToTerminal?: (brief: string) => void;
}

const dotOf = (areas: BoardArea[], area: string) =>
  areas.find((a) => a.name === area)?.dot || 'var(--line-3)';

/** Whole days since an ISO stamp; null = it carries none. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
}

function Card({ it, areas, onOpen, children }: {
  it: RoadmapItem; areas: BoardArea[]; onOpen: (i: RoadmapItem) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rp-card" draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(it.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      // Double-click opens the item, the same gesture as every other card and
      // row on this tab.
      onDoubleClick={() => onOpen(it)}
      title="Double-click to open">
      {it.labels.length > 0 && (
        <div className="rp-stripes">
          {labelsOf(it.labels).map((l) => (
            <span key={l.id} className={`rp-stripe rl-${l.tone}`} title={l.name} />
          ))}
        </div>
      )}
      <div className="rp-title">{it.title}</div>
      <div className="rp-meta">
        <span className="dot" style={{ background: dotOf(areas, it.area) }} />
        <span className="area">{it.area || 'untagged'}</span>
        <span className={`rp-mos ${it.bucket}`}>{BUCKET_LABEL[it.bucket]}</span>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RoadmapTiers({
  items, areas, areaFilter, onSetTier, onOpen, onCleanup, onSendToTerminal,
}: BoardsProps) {
  // The run queue's population: open work that is actually pickable. `inCycle`
  // rules out the three things the fleet will never reach — archived is off the
  // board, PARKED is explicitly not to be picked up, and a WON'T is out of scope
  // entirely — and it is the same predicate the area chips count with, so the
  // number on a chip and the cards under it are one population.
  const pool = items.filter((i) =>
    !i.done && inCycle(i) && (areaFilter === '' || i.area === areaFilter));

  const brief = () => {
    const top = pool.filter((i) => i.tier === 'S' || i.tier === 'A').slice(0, 8);
    return top.length
      ? `Work these in order:\n${top.map((i, n) => `${n + 1}. [${i.tier}] ${i.title}`).join('\n')}`
      : 'Nothing is ranked S or A yet.';
  };

  return (
    <div className="rp">
      <div className="rp-bar">
        <span className="lbl">Tiers</span>
        <span className="rp-bar-hint">
          how much you want a thing NEXT — the run queue’s primary sort. Drag a card to rank it.
        </span>
        {onSendToTerminal && (
          <button className="rail-link" onClick={() => onSendToTerminal(brief())}
            title="Send the S and A ranking to a terminal session as a brief">Send to terminal</button>
        )}
        {onCleanup && (
          <button className="gemini-btn sm" onClick={onCleanup}
            title="✧ Read the board and suggest merges, splits and stale rows">✧ Clean up</button>
        )}
      </div>

      <div className="rp-cols">
        {TIER_COLS.map((col) => {
          const cards = pool.filter((i) => (i.tier || '') === col.key);
          return (
            <div className={`rp-col${col.key === '' ? ' unranked' : ''}`} key={col.key || 'unranked'}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const it = items.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')));
                if (it && (it.tier || '') !== col.key) onSetTier(it, col.key);
              }}>
              <div className="rp-col-head">
                <span className="nm">{col.name}</span>
                <span className="n">{cards.length}</span>
              </div>
              <div className="rp-col-meta">{col.meta}</div>
              {cards.map((c) => (
                <Card key={c.id} it={c} areas={areas} onOpen={onOpen}>
                  {c.claimedBy && <span className="est" title={`Claimed on ${c.claimedBy}`}>⚑</span>}
                </Card>
              ))}
              {cards.length === 0 && <div className="rp-col-empty">—</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RoadmapParked({
  items, areas, areaFilter, staleItemDays = 14, onToggleSkip, onOpen,
}: BoardsProps) {
  const parked = items.filter((i) =>
    i.skipped && !i.done && !i.archived
    && (areaFilter === '' || i.area === areaFilter));
  const stale = parked.filter((i) => (daysSince(i.skippedAt) ?? 0) >= staleItemDays).length;

  return (
    <div className="rp">
      <div className="rp-bar">
        <span className="lbl">Parked</span>
        <span className="rp-bar-hint">
          cut from this cycle, still part of the feature — {parked.length} on the shelf
          {stale > 0 && `, ${stale} past ${staleItemDays} days`}
        </span>
      </div>

      {parked.length === 0 ? (
        <div className="rail-empty">Nothing parked. Every open item is in play.</div>
      ) : (
        <div className="rp-cols">
          {PARK_COLS.map((bucket) => {
            // Oldest park first: the whole point of the shelf is what has been
            // sitting longest. An unstamped row sorts LAST rather than as
            // parked today — unknown is not fresh.
            const cards = parked
              .filter((i) => i.bucket === bucket)
              .map((it) => ({ it, days: daysSince(it.skippedAt) }))
              .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
            return (
              <div className="rp-col" key={bucket}>
                <div className="rp-col-head">
                  <span className="nm">{BUCKET_LABEL[bucket]}</span>
                  <span className="n">{cards.length}</span>
                </div>
                {cards.map(({ it, days }) => (
                  <Card key={it.id} it={it} areas={areas} onOpen={onOpen}>
                    <span className={`est${days !== null && days >= staleItemDays ? ' stale' : ''}`}
                      title={days === null
                        ? 'Parked before Stack recorded when — the age is unknown, not zero'
                        : `Parked ${days} days ago`}>
                      {days === null ? 'parked' : `${days}d`}
                    </span>
                    <button className="rp-unpark" onClick={() => onToggleSkip(it)}
                      title="Unpark — back in play">▶</button>
                  </Card>
                ))}
                {cards.length === 0 && <div className="rp-col-empty">—</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
