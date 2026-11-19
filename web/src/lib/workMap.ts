// THE WORK MAP'S MODEL — the Board tab's Map view (detail/BoardMap.tsx), as
// pure functions so `scripts/work-map.test.mjs` can run them under Node.
//
// The map draws the spine as one tree: project → milestone → JOB (a slice) →
// TASK (a board row) → TICKET (a part, `parent_id`, one level deep). The
// words are the design's (Board Map, 2026-11-18); the data is the spine's and
// nothing here stores anything. Rules the code depends on:
//
//  1. WHAT IS ON THE MAP IS WHAT IS ON THE BOARD. A task is a row `isBoardWork`
//     admits (`homeOf` in lib/plan.ts is the one line between screens), so the
//     Icebox and auto-ideas stay off the map and are counted in its rail
//     instead. A ticket is any unarchived part of a task on the map, which is
//     the kanban's cluster rule (Board.tsx `partsOf`), so the two views agree.
//  2. A TASK IN NO LIVE SLICE HANGS OFF THE PROJECT (worked rows in no slice,
//     or rows in an archived slice): in-flight work must never vanish.
//  3. EVERY STATUS IS DERIVED. A task's column is `listKeyOf`, or
//     `clusterKeyOf` when it has parts, the kanban's own answer. A job's status
//     is rolled up from its tasks, a milestone's is its stored status. "Done"
//     means ticked or verdicted, never "on main": Stack cannot see a merge.
//  4. A NODE'S SESSION IS ITS `term:` CLAIM (lib/termLaunch.ts termClaim).
//     Whether that session is still alive is the host's to say (the caller
//     passes the live tmux names), and an unknown host is not a dead session.
//  5. ORDER IS THE RUNNER'S: milestones and slices by `position`, tasks and
//     tickets by `queueOrder` over the current milestone's live slices.

import type { Milestone, RoadmapItem, Slice } from '../types';
import { clusterKeyOf, isAutoIdea, isBoardWork, isIced, isWorked, listKeyOf, queueOrder } from './plan';
import { isHeld } from './approval';

export type NodeType = 'project' | 'milestone' | 'job' | 'task' | 'ticket';
export type NodeStatus =
  | 'planned' | 'ready' | 'held' | 'parked' | 'active' | 'review' | 'done'
  | 'current' | 'achieved' | 'empty';

export interface MapNode {
  key: string;
  type: NodeType;
  ref: string;
  title: string;
  status: NodeStatus;
  parent: string | null;
  kids: string[];
  item?: RoadmapItem;
  slice?: Slice;
  milestone?: Milestone;
  /** The tmux name of the `term:` claim on this row ('' = none). */
  session: string;
}

export interface WorkMap {
  nodes: Map<string, MapNode>;
  /** Icebox rows plus auto-ideas: kept, but not on the map (rule 1). */
  offMap: { iced: number; ideas: number };
}

export const ROOT = 'P';
export const itemKey = (id: number) => `i:${id}`;
export const sliceKey = (id: number) => `s:${id}`;
export const msKey = (id: number) => `m:${id}`;

export const TYPE_LABEL: Record<NodeType, string> = {
  project: 'Project', milestone: 'Milestone', job: 'Job', task: 'Task', ticket: 'Ticket',
};
/** What a node's children are called, in the detail panel. */
export const KIDS_LABEL: Record<NodeType, string> = {
  project: 'On the map', milestone: 'Jobs', job: 'Tasks', task: 'Tickets', ticket: 'Contains',
};

export const isDone = (s: NodeStatus) => s === 'done' || s === 'achieved';
/** The statuses "Focus active work" keeps lit. */
export const isHot = (s: NodeStatus) => s === 'active' || s === 'review';

const sessionOf = (it: RoadmapItem) => {
  const c = it.claimedBy.trim();
  return c.startsWith('term:') ? c.slice(5) : '';
};

/** A task's or ticket's status, off the same derivations the kanban uses. */
export function itemStatus(it: RoadmapItem, parts: RoadmapItem[] = []): NodeStatus {
  const k = parts.length ? clusterKeyOf(it, parts) : listKeyOf(it);
  if (k === 'shipped') return 'done';
  if (k === 'review') return 'review';
  if (k === 'progress') return 'active';
  if (it.skipped) return 'parked';
  if (isHeld(it) && !isWorked(it)) return 'held';
  if (it.ready) return 'ready';
  return 'planned';
}

/** A job's status, rolled up from its tasks (rule 3). */
export function rollUp(kids: NodeStatus[]): NodeStatus {
  if (!kids.length) return 'empty';
  if (kids.every(isDone)) return 'done';
  if (kids.every((s) => isDone(s) || s === 'review')) return 'review';
  if (kids.some((s) => s === 'active' || s === 'review' || isDone(s))) return 'active';
  if (kids.some((s) => s === 'ready')) return 'ready';
  return 'planned';
}

export function buildWorkMap(
  project: { slug: string; name: string },
  rows: RoadmapItem[], milestones: Milestone[], slices: Slice[],
): WorkMap {
  const nodes = new Map<string, MapNode>();
  const put = (n: MapNode) => { nodes.set(n.key, n); if (n.parent) nodes.get(n.parent)?.kids.push(n.key); };
  put({ key: ROOT, type: 'project', ref: project.slug, title: project.name, status: 'current', parent: null, kids: [], session: '' });

  const msOrdered = [...milestones].sort((a, b) => a.position - b.position || a.id - b.id);
  const current = milestones.find((m) => m.status === 'active');
  const liveSl = slices.filter((s) => !s.archived);
  const planning = liveSl.filter((s) => s.milestoneId === current?.id)
    .sort((a, b) => a.position - b.position || a.id - b.id).map((s) => s.id);
  const order = queueOrder(planning);

  let j = 0;
  msOrdered.forEach((m, i) => {
    put({ key: msKey(m.id), type: 'milestone', ref: `M${i + 1}`, title: m.name,
      status: m.status === 'done' ? 'achieved' : m.status === 'active' ? 'current' : 'planned',
      parent: ROOT, kids: [], milestone: m, session: '' });
    liveSl.filter((s) => s.milestoneId === m.id)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .forEach((s) => {
        j += 1;
        put({ key: sliceKey(s.id), type: 'job', ref: `J${j}`, title: s.title, status: 'empty',
          parent: msKey(m.id), kids: [], slice: s, session: '' });
      });
  });

  const live = rows.filter((it) => !it.archived);
  const top = live.filter((it) => isBoardWork(it)).sort(order);
  const topIds = new Set(top.map((it) => it.id));
  // A part of a part is still drawn, under the task its own parent hangs from.
  const tasks = top.filter((it) => it.parentId === null || !topIds.has(it.parentId)
    || live.find((p) => p.id === it.parentId)?.parentId != null);
  const taskIds = new Set(tasks.map((it) => it.id));
  const partsOf = new Map<number, RoadmapItem[]>();
  for (const it of [...live].sort(order)) {
    if (it.parentId === null || !taskIds.has(it.parentId) || taskIds.has(it.id)) continue;
    const bag = partsOf.get(it.parentId);
    if (bag) bag.push(it); else partsOf.set(it.parentId, [it]);
  }

  for (const it of tasks) {
    const home = it.sliceId !== null && nodes.has(sliceKey(it.sliceId)) ? sliceKey(it.sliceId) : ROOT;
    const parts = partsOf.get(it.id) || [];
    put({ key: itemKey(it.id), type: 'task', ref: `#${it.id}`, title: it.title, status: itemStatus(it, parts),
      parent: home, kids: [], item: it, session: sessionOf(it) });
    for (const p of parts) {
      put({ key: itemKey(p.id), type: 'ticket', ref: `#${p.id}`, title: p.title, status: itemStatus(p),
        parent: itemKey(it.id), kids: [], item: p, session: sessionOf(p) });
    }
  }

  for (const n of nodes.values()) {
    if (n.type === 'job') n.status = rollUp(n.kids.map((k) => nodes.get(k)!.status));
  }

  let iced = 0; let ideas = 0;
  for (const it of live) {
    if (nodes.has(itemKey(it.id))) continue;
    if (isAutoIdea(it)) ideas += 1; else if (isIced(it)) iced += 1;
  }
  return { nodes, offMap: { iced, ideas } };
}

/** Every key under `key`, not counting itself. */
export function descendants(map: WorkMap, key: string): string[] {
  const out: string[] = [];
  const walk = (k: string) => { for (const c of map.nodes.get(k)?.kids || []) { out.push(c); walk(c); } };
  walk(key);
  return out;
}

/** Root first, down to (not including) `key`. */
export function ancestors(map: WorkMap, key: string): string[] {
  const out: string[] = [];
  let n = map.nodes.get(key);
  while (n?.parent) { out.unshift(n.parent); n = map.nodes.get(n.parent); }
  return out;
}

/** The hot nodes and every ancestor of one: what "Focus active work" keeps lit. */
export function activeSet(map: WorkMap): Set<string> {
  const set = new Set<string>();
  for (const n of map.nodes.values()) {
    if (n.type !== 'task' && n.type !== 'ticket') continue;
    if (!isHot(n.status)) continue;
    set.add(n.key);
    for (const a of ancestors(map, n.key)) set.add(a);
  }
  return set;
}

// ---- layout -----------------------------------------------------------------

export const CARD_W = 204;
export const CARD_H = 94;
const COL_W = 248;
const ROW_H = 110;
const PAD = 36;

export type MapLayoutMode = 'tree' | 'stage';
export interface Placed { x: number; y: number; w: number; depth: number; folded: boolean }
export interface Head { x: number; y: number; label: string; tone: string; count: string }
export interface Band { x: number; y: number; w: number; h: number }
export interface Laid { pos: Map<string, Placed>; W: number; H: number; mode: MapLayoutMode; heads: Head[]; bands: Band[] }

export const STAGES = ['To do', 'Building', 'For review', 'Done'] as const;
export const stageOf = (s: NodeStatus) => (s === 'active' ? 1 : s === 'review' ? 2 : isDone(s) ? 3 : 0);

/** Lay the map out. `folded(key)` says whether a node with children is folded. */
export function layoutMap(map: WorkMap, mode: MapLayoutMode, folded: (key: string) => boolean): Laid {
  return mode === 'stage' ? stageLayout(map, folded) : treeLayout(map, folded);
}

function treeLayout(map: WorkMap, folded: (key: string) => boolean): Laid {
  const pos = new Map<string, Placed>();
  let row = 0;
  let maxDepth = 0;
  const walk = (key: string, depth: number): number => {
    const kids = map.nodes.get(key)?.kids || [];
    const fold = kids.length > 0 && folded(key);
    let slot: number;
    if (!kids.length || fold) { slot = row; row += 1; }
    else { const ys = kids.map((k) => walk(k, depth + 1)); slot = (ys[0] + ys[ys.length - 1]) / 2; }
    maxDepth = Math.max(maxDepth, depth);
    pos.set(key, { x: PAD + depth * COL_W, y: PAD + slot * ROW_H, w: CARD_W, depth, folded: fold });
    return slot;
  };
  walk(ROOT, 0);
  return { pos, W: PAD * 2 + maxDepth * COL_W + CARD_W + 24, H: PAD * 2 + Math.max(row, 1) * ROW_H, mode: 'tree', heads: [], bands: [] };
}

// STAGE FLOW: one lane per scope (the project's loose work, each milestone,
// each job), its tasks and tickets spread across the four stages.
function stageLayout(map: WorkMap, folded: (key: string) => boolean): Laid {
  const pos = new Map<string, Placed>();
  const SCW = 320; const RH = CARD_H + 12; const TOP = PAD + 36; const IND = 26;
  const SX = (i: number) => PAD + 300 + IND * 2 + i * (SCW + 56);
  const counts = [0, 0, 0, 0];
  let y = TOP;
  const node = (k: string) => map.nodes.get(k)!;
  const fold = (k: string) => node(k).kids.length > 0 && folded(k);
  const place = (k: string, x: number, yy: number, w = CARD_W) => pos.set(k, { x, y: yy, w, depth: 0, folded: fold(k) });
  const work = (k: string): string[] => {
    const out: string[] = [];
    const walk = (c: string) => {
      for (const kid of node(c).kids) {
        const t = node(kid).type;
        if (t === 'task' || t === 'ticket') out.push(kid);
        walk(kid);
      }
    };
    walk(k);
    return out;
  };
  const lane = (head: string, list: string[]) => {
    const t = node(head).type;
    place(head, PAD + (t === 'milestone' ? IND : t === 'job' ? IND * 2 : 0), y);
    const cnt = [0, 0, 0, 0];
    for (const k of list) { const c = stageOf(node(k).status); place(k, SX(c), y + cnt[c] * RH, SCW); cnt[c] += 1; counts[c] += 1; }
    y += Math.max(1, ...cnt) * RH + 20;
  };
  const rootKids = node(ROOT).kids;
  lane(ROOT, rootKids.filter((k) => node(k).type === 'task' || node(k).type === 'ticket').flatMap((k) => [k, ...work(k)]));
  for (const m of rootKids.filter((k) => node(k).type === 'milestone')) {
    lane(m, []);
    if (fold(m)) continue;
    for (const j of node(m).kids) lane(j, fold(j) ? [] : work(j));
  }
  const H = y + PAD; const W = SX(3) + SCW + PAD;
  const tones = ['var(--grey-500)', 'var(--blue-500)', 'var(--amber-500)', 'var(--lime-500)'];
  const heads: Head[] = [
    { x: PAD, y: PAD, label: 'Scope', tone: 'var(--text-tertiary)', count: '' },
    ...STAGES.map((label, i) => ({ x: SX(i) + 4, y: PAD, label, tone: tones[i], count: String(counts[i]) })),
  ];
  const bands = STAGES.map((_, i) => ({ x: SX(i) - 12, y: TOP - 12, w: SCW + 24, h: H - TOP - PAD + 4 }));
  return { pos, W, H, mode: 'stage', heads, bands };
}

/** The SVG path from a parent's card to a child's. */
export function edgePath(a: Placed, b: Placed): string {
  const y1 = a.y + CARD_H / 2; const y2 = b.y + CARD_H / 2;
  if (Math.abs(a.x - b.x) < 4) {
    const x = a.x;
    return `M${x} ${y1} C${x - 30} ${y1}, ${x - 30} ${y2}, ${x} ${y2} `;
  }
  if (b.x > a.x && b.x < a.x + a.w) {
    const x = a.x + 12;
    return `M${x} ${a.y + CARD_H} L${x} ${y2 - 8} Q${x} ${y2}, ${x + 8} ${y2} L${b.x} ${y2} `;
  }
  if (b.x > a.x) {
    const x1 = a.x + a.w + 12; const x2 = b.x; const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2} `;
  }
  const x1 = a.x; const x2 = b.x + b.w; const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2} `;
}
