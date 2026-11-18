// THE TERMINAL'S BOARD PEEK: which rows the side drawer shows, and in what
// order. It is a glance at the board without leaving a session, so it draws
// the board's own truth and never a second one:
//
//  · ONLY BOARD WORK (`isBoardWork`). Auto-ideas and the Icebox live on other
//    screens, and a row drawn here that the board doesn't show is a row the
//    owner goes looking for and can't find.
//  · THE BOARD'S COLUMNS, with a cluster rolled up from its parts
//    (`clusterKeyOf`) and its parts drawn inside it, never as rows of their
//    own, exactly as the board does.
//  · TO DO IN RUN ORDER (`queueOrder` over the current milestone's live
//    slices), so the top of the list is what a build would take next.
//  · READ-ONLY. Nothing here writes; acting on a row is the board's job, one
//    ⌃` away.

import type { Milestone, RoadmapItem, Slice } from '../types';
import { clusterKeyOf, isBoardWork, listKeyOf, queueOrder } from './plan';

export interface PeekRow { item: RoadmapItem; parts: RoadmapItem[] }
export interface PeekGroup { key: string; label: string; rows: PeekRow[] }

/** The columns in the order a glance wants them: what is moving first. */
export const PEEK_COLUMNS: { key: string; label: string }[] = [
  { key: 'progress', label: 'In progress' },
  { key: 'review', label: 'In review' },
  { key: 'planned', label: 'To do' },
  { key: 'shipped', label: 'Done' },
];

/** The current milestone's live slice ids in board order (`queueOrder`'s input). */
export function planningSliceIds(milestones: Milestone[], slices: Slice[]): number[] {
  const cur = milestones.find((m) => m.status === 'active');
  if (!cur) return [];
  return slices
    .filter((s) => s.milestoneId === cur.id && !s.archived)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((s) => s.id);
}

const matches = (it: RoadmapItem, q: string): boolean =>
  !q || `#${it.id} ${it.title} ${it.area}`.toLowerCase().includes(q);

export function peekGroups(
  rows: RoadmapItem[], milestones: Milestone[], slices: Slice[], query = '',
): PeekGroup[] {
  const live = rows.filter((it) => !it.archived && isBoardWork(it));
  const onBoard = new Set(live.map((it) => it.id));
  const partsOf = new Map<number, RoadmapItem[]>();
  for (const it of live) {
    if (it.parentId === null || !onBoard.has(it.parentId)) continue;
    const list = partsOf.get(it.parentId) ?? [];
    list.push(it);
    partsOf.set(it.parentId, list);
  }
  const q = query.trim().toLowerCase();
  const order = queueOrder(planningSliceIds(milestones, slices));
  const byKey = new Map<string, PeekRow[]>();
  for (const it of live) {
    // A part whose cluster is on the board is drawn inside it.
    if (it.parentId !== null && onBoard.has(it.parentId)) continue;
    const parts = partsOf.get(it.id) ?? [];
    if (!matches(it, q) && !parts.some((p) => matches(p, q))) continue;
    const key = parts.length ? clusterKeyOf(it, parts) : listKeyOf(it);
    const list = byKey.get(key) ?? [];
    list.push({ item: it, parts });
    byKey.set(key, list);
  }
  const known = new Set(PEEK_COLUMNS.map((c) => c.key));
  const cols = [
    ...PEEK_COLUMNS,
    // A custom list key the board knows and this file doesn't still gets drawn,
    // under its own name, rather than silently vanishing.
    ...[...byKey.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, label: k })),
  ];
  return cols
    .map(({ key, label }) => {
      const list = byKey.get(key) ?? [];
      if (key === 'planned') list.sort((a, b) => order(a.item, b.item));
      // Done reads newest first: the glance is "what just landed".
      if (key === 'shipped') list.sort((a, b) => String(b.item.updatedAt ?? '').localeCompare(String(a.item.updatedAt ?? '')) || b.item.id - a.item.id);
      return { key, label, rows: list };
    })
    .filter((g) => g.rows.length);
}
