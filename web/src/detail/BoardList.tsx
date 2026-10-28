// THE BOARD'S LIST VIEW — every item on one sortable list, with its area as a
// tag (owner's request, 2026-10-10: "collapse all the areas into a single list
// with tags … sort by latest").
//
// The Areas view groups board work into folded area sections, which is right
// for steering the lanes and wrong for FINDING something: a freshly filed item
// sits in a folded section of an area you may not know exists, or held in
// For you → Auto-ideas. This view answers "where is it" in one place, so it
// deliberately crosses the screens `homeOf` separates:
//
//  · IT DRAWS EVERY NON-ARCHIVED ROW, board work and Auto-ideas alike, and
//    says which screen each one belongs to (the Where column). It is a
//    finder, not a third home: nothing here acts on a row except opening
//    it in the item modal, so a row is still WORKED on exactly one screen.
//  · THE STATUS IS THE BOARD'S OWN COLUMN NAME for board work (`columnOf`
//    semantics, read off the live lists), never a hard-coded four.
//  · "RUN ORDER" IS `queueOrder`, the runner's twin, over rows still in
//    payload order. Every other sort is a plain comparator with id as the
//    tie-break, so two renders of the same rows never disagree.

import { useMemo } from 'react';
import type { BoardArea, BoardList as BoardColumn, RoadmapItem, Sprint } from '../types';
import { homeOf, listKeyOf, queueOrder, bucketRank } from '../lib/plan';
import { isHeld } from '../lib/approval';
import { priorityMeta, timeAgo } from '../lib/ui';
import type { BoardShow, BoardSort } from '../store';

export const SORT_LABEL: Record<BoardSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  updated: 'Recently updated',
  priority: 'Priority',
  run: 'Run order',
  area: 'Area',
  title: 'Title A–Z',
};

export const SHOW_LABEL: Record<BoardShow, string> = {
  all: 'Everything',
  board: 'Board work',
  ideas: 'Auto-ideas only',
};

const stamp = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/** Where a row is worked, in the words the rest of the app uses. */
function whereOf(it: RoadmapItem): { label: string; tone: string; title: string } {
  const home = homeOf(it);
  if (home === 'auto') return { label: 'Auto-idea', tone: 'warning', title: 'Held for your sign-off in For you → Auto-ideas' };
  return { label: 'Board', tone: 'info', title: 'Committed work, on the board' };
}

export function sortRows(rows: RoadmapItem[], sort: BoardSort, activeId: number | null): RoadmapItem[] {
  const out = [...rows];
  const byNewest = (a: RoadmapItem, b: RoadmapItem) => stamp(b.createdAt) - stamp(a.createdAt) || b.id - a.id;
  switch (sort) {
    case 'run': return out.sort(queueOrder(activeId));
    case 'oldest': return out.sort((a, b) => -byNewest(a, b));
    case 'updated': return out.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || b.id - a.id);
    case 'priority': return out.sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket) || byNewest(a, b));
    case 'area': return out.sort((a, b) => {
      // Untagged last, like the Areas view.
      const x = a.area.trim(); const y = b.area.trim();
      if (!x !== !y) return x ? -1 : 1;
      return x.localeCompare(y) || byNewest(a, b);
    });
    case 'title': return out.sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
    default: return out.sort(byNewest);
  }
}

export function BoardListView({ rows, sort, show, area, lists, areas, sprints, activeId, selected, onOpen }: {
  /** Already filtered for archive, search and parked by the board. */
  rows: RoadmapItem[];
  sort: BoardSort;
  show: BoardShow;
  /** '' = every area; otherwise one area name, or ' untagged'. */
  area: string;
  lists: BoardColumn[];
  areas: BoardArea[];
  sprints: Sprint[];
  activeId: number | null;
  selected: number | null;
  onOpen: (it: RoadmapItem) => void;
}) {
  const titles = useMemo(() => new Map(rows.map((r) => [r.id, r.title])), [rows]);
  const drawn = useMemo(() => {
    const scoped = rows.filter((it) => {
      const home = homeOf(it);
      if (show === 'board' && home !== 'board') return false;
      if (show === 'ideas' && home === 'board') return false;
      if (area === ' untagged') return !it.area.trim();
      return !area || it.area.trim() === area;
    });
    return sortRows(scoped, sort, activeId);
  }, [rows, sort, show, area, activeId]);

  if (drawn.length === 0) return <div className="km-colempty">Nothing matches those filters.</div>;

  return (
    <div className="bl-list" role="table" aria-label="Every item, as a list">
      <div className="bl-row bl-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Title</span>
        <span role="columnheader">Area</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="bl-c-pri" title="Priority">Pri</span>
        <span role="columnheader" className="bl-c-pts">Pts</span>
        <span role="columnheader" className="bl-c-sprint">Sprint</span>
        <span role="columnheader" className="bl-c-when">Created</span>
        <span role="columnheader" className="bl-c-when">Updated</span>
      </div>
      {drawn.map((it) => {
        const where = whereOf(it);
        const col = lists.find((l) => l.key === listKeyOf(it));
        const status = homeOf(it) === 'board' ? (col?.name || 'No column') : where.label;
        const pri = priorityMeta(it.bucket);
        const dot = areas.find((a) => a.name === it.area.trim())?.dot || '';
        const box = it.sprintId === null ? null : sprints.find((b) => b.id === it.sprintId) || null;
        const parent = it.parentId === null ? '' : titles.get(it.parentId) || '';
        return (
          <div key={it.id} role="row" data-hl={it.id}
            className={`bl-row${selected === it.id ? ' selected' : ''}${it.done ? ' done' : ''}`}
            tabIndex={0}
            onClick={() => onOpen(it)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(it); }}>
            <span className="bl-id mono" role="cell">#{it.id}</span>
            <span className="bl-title" role="cell">
              <span className="t">{it.title}</span>
              {it.parentId !== null && (
                <span className="bl-parent" title={`Part of #${it.parentId}`}>↳ #{it.parentId}{parent ? ` ${parent}` : ''}</span>
              )}
            </span>
            <span role="cell">
              <span className={`k-tag bl-area${it.area.trim() ? '' : ' none'}`}>
                {dot && <span className="km-dot" style={{ background: dot }} />}
                {it.area.trim() || 'no area'}
              </span>
            </span>
            <span role="cell" className="bl-status">
              <span className={`k-tag ${homeOf(it) === 'board' ? `km-status st-${(col?.key || 'none').trim()}` : where.tone}`.trim()}
                title={where.title}>{status}</span>
              {homeOf(it) === 'board' && isHeld(it) && <span className="k-tag warning" title="Not signed off — the runner skips it">held</span>}
              {it.skipped && <span className="k-tag warning">parked</span>}
            </span>
            <span role="cell" className="bl-c-pri" style={{ color: pri.color }} title={`Priority — ${pri.label}`}>{pri.glyph}</span>
            <span role="cell" className="bl-c-pts mono">{it.points ?? ''}</span>
            <span role="cell" className="bl-c-sprint">
              {box && <span className={`k-tag${box.id === activeId ? ' info' : ''}`} title={`Sprint: ${box.name} (${box.status})`}>{box.name}</span>}
            </span>
            <span role="cell" className="bl-c-when" title={it.createdAt || ''}>{timeAgo(it.createdAt)}</span>
            <span role="cell" className="bl-c-when" title={it.updatedAt || ''}>{timeAgo(it.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
