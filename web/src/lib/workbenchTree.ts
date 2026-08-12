import type { WorkbenchCard } from '../types';

/**
 * THE WORKBENCH'S TREE (#414) — everything the Explorer needs to answer "what
 * is in this folder", "where am I" and "may this go there", as pure functions
 * over the cards the API already sends.
 *
 * It is a separate module for one reason: the folder rules are the part of the
 * canvas that can be WRONG in ways a render does not show. A cycle draws as a
 * folder that opens into itself forever; a smart folder that quietly counts
 * archived work reads as a backlog you do not have. Both are answerable by a
 * pure function and neither is answerable by looking at the screen, so they
 * live here and `scripts/workbench-tree.test.mjs` pins them.
 *
 * TWO THINGS THAT ARE NOT STORED AND MUST NOT BECOME STORED:
 *
 *  • A SMART FOLDER IS A QUERY. "Stale · 30d+" is a predicate over the cards,
 *    evaluated on read. The moment one becomes a row, filing a card into it is
 *    a thing the UI has to allow and the predicate stops being true of its
 *    contents — a folder called "stale" holding fresh work.
 *  • THE ROOT HAS NO ROW. `parentId === null` is the root, which is the project
 *    itself. A root card would be a second spelling of `projects` that every
 *    read would have to keep in step, and the first drift would be a canvas
 *    whose breadcrumb disagrees with its title.
 */

/** The root's id in navigation state. Not a card id — the root has no card. */
export const ROOT: null = null;

/** Where the Explorer can be: a real folder card, or the root, or a smart folder. */
export type FolderId = number | null | SmartKey;

export type SmartKey = 'smart:stale' | 'smart:polaris' | 'smart:sessions' | 'smart:loose';

export const isSmart = (id: FolderId): id is SmartKey =>
  typeof id === 'string' && id.startsWith('smart:');

/** How old a card has to be before the Explorer calls it stale. */
export const STALE_DAYS = 30;

export interface Smart {
  key: SmartKey;
  name: string;
  /** Which semantic tone paints its dot — a token name, never a hex (see styles.css). */
  tone: string;
  test: (c: WorkbenchCard, all: WorkbenchCard[]) => boolean;
}

/**
 * The four saved searches. Order is the order they are shown in, and it runs
 * most-urgent-first: what has gone quiet, what is unresolved, what arrived on
 * its own, what nobody has filed.
 */
export const SMART: Smart[] = [
  {
    key: 'smart:stale',
    name: 'Stale · 30d+',
    tone: 'var(--paused)',
    test: (c) => c.kind !== 'folder' && c.days >= STALE_DAYS,
  },
  {
    key: 'smart:polaris',
    name: 'Polaris · on the canvas',
    tone: 'var(--accent)',
    test: (c) => c.kind === 'polaris',
  },
  {
    key: 'smart:sessions',
    name: 'From the ops',
    tone: 'var(--live)',
    test: (c) => c.kind === 'ai',
  },
  {
    // "Loose" is the population the whole folder feature exists for: work
    // sitting at the top level with nothing said about where it belongs. A
    // folder at the root is not loose — it IS somewhere.
    key: 'smart:loose',
    name: 'Loose at the top',
    tone: 'var(--building)',
    test: (c) => c.parentId === null && c.kind !== 'folder',
  },
];

export const smartOf = (id: FolderId): Smart | undefined =>
  SMART.find((s) => s.key === id);

/** Is this card one that other cards may be filed into? */
export const isFolder = (c: WorkbenchCard | undefined | null): boolean => !!c && c.kind === 'folder';

/**
 * What is directly inside a folder. A smart folder answers with its query over
 * the WHOLE canvas — which is why it is flat and has no depth: a saved search
 * that only searched one folder would be a filter, and there is one of those in
 * the toolbar already.
 */
export function childrenOf(cards: WorkbenchCard[], id: FolderId): WorkbenchCard[] {
  const smart = smartOf(id);
  if (smart) return cards.filter((c) => smart.test(c, cards));
  return cards.filter((c) => c.parentId === id);
}

/**
 * Everything under a folder, at any depth. Guarded against a cycle it should
 * never see — the server refuses to write one — because a client that trusts
 * the shape of remote data and is wrong about it hangs the tab rather than
 * showing a bad row, and the two failures are not comparable.
 */
export function descendantsOf(cards: WorkbenchCard[], id: FolderId): WorkbenchCard[] {
  const out: WorkbenchCard[] = [];
  const seen = new Set<number>();
  const walk = (at: FolderId) => {
    for (const c of childrenOf(cards, at)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      if (isFolder(c)) walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** How many things are inside — the count the Explorer prints beside a folder. */
export const countIn = (cards: WorkbenchCard[], id: FolderId): number => childrenOf(cards, id).length;

export interface Crumb { id: FolderId; name: string }

/**
 * The breadcrumb, root first. The root's name is the PROJECT's, passed in
 * rather than looked up, because the tree does not know what project it is and
 * should not have to.
 */
export function pathTo(cards: WorkbenchCard[], id: FolderId, rootName: string): Crumb[] {
  const smart = smartOf(id);
  if (smart) return [{ id: ROOT, name: rootName }, { id: smart.key, name: smart.name }];
  const chain: Crumb[] = [];
  const seen = new Set<number>();
  let at: number | null = typeof id === 'number' ? id : null;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const card: WorkbenchCard | undefined = cards.find((c) => c.id === at);
    if (!card) break;
    chain.unshift({ id: card.id, name: card.title || 'Untitled folder' });
    at = card.parentId;
  }
  return [{ id: ROOT, name: rootName }, ...chain];
}

/**
 * WHERE "UP ONE LEVEL" GOES FROM HERE, or null when there is nowhere above.
 *
 * IT RETURNS A BOX, and that is the whole point of it being a function. `null`
 * is already the ROOT — a real, common destination — so a bare id return cannot
 * also carry "nowhere to go" without the two meanings colliding. They did
 * collide in the first cut, and the result was Up disabled inside every folder
 * that sits at the root, which is most of them. Same hazard as the server's
 * BAD_PARENT sentinel, and the same fix.
 */
export function upFrom(cards: WorkbenchCard[], id: FolderId): { to: FolderId } | null {
  if (isSmart(id)) return { to: ROOT };        // a query's parent is the root
  if (id === ROOT) return null;                // the root has nothing above it
  return { to: cards.find((c) => c.id === id)?.parentId ?? ROOT };
}

/**
 * MAY `cardId` BE FILED INTO `target`? The client's copy of the server's guard,
 * and it exists so a drop that will be refused never draws as accepted — not so
 * the server can trust it. Both halves have to say no; only the server's is
 * safe against two tabs at once (its guard is inside the UPDATE), and this one
 * would be the wrong place to enforce it even if it were.
 */
export function canFileInto(cards: WorkbenchCard[], cardId: number, target: FolderId): boolean {
  if (isSmart(target)) return false;              // a query holds nothing
  if (target === cardId) return false;            // nothing contains itself
  const card = cards.find((c) => c.id === cardId);
  if (!card) return false;
  if (card.parentId === target) return false;     // already there — not a move
  if (target === null) return true;               // out to the root is always legal
  const folder = cards.find((c) => c.id === target);
  if (!isFolder(folder)) return false;
  // Walk UP from the target: a folder may not move into its own descendant.
  const seen = new Set<number>();
  let at: number | null = target;
  while (at !== null && !seen.has(at)) {
    if (at === cardId) return false;
    seen.add(at);
    at = cards.find((c) => c.id === at)?.parentId ?? null;
  }
  return true;
}

export type SortKey = 'name' | 'kind' | 'items' | 'updated';

const KIND_ORDER: Record<WorkbenchCard['kind'], number> = {
  folder: 0, polaris: 1, ai: 2, note: 3,
};

/** What a card is called in the Kind column, and in a folder's contents list. */
export const KIND_LABEL: Record<WorkbenchCard['kind'], string> = {
  folder: 'Folder', polaris: 'Polaris', ai: 'Op output', note: 'Note',
};

/**
 * Sort for the Tiles and Details views. FOLDERS FIRST under a name sort and
 * only under a name sort: that is the convention every file browser has, and
 * forcing it under "oldest first" would be the sort lying about what it did.
 */
export function sortCards(list: WorkbenchCard[], key: SortKey, dir: 1 | -1, cards: WorkbenchCard[]): WorkbenchCard[] {
  const val = (c: WorkbenchCard): string | number => {
    if (key === 'name') return (c.title || '').toLowerCase();
    if (key === 'kind') return KIND_ORDER[c.kind];
    if (key === 'items') return isFolder(c) ? countIn(cards, c.id) : -1;
    return c.days;
  };
  return list.slice().sort((a, b) => {
    if (key === 'name') {
      const fa = isFolder(a) ? 0 : 1;
      const fb = isFolder(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    const va = val(a);
    const vb = val(b);
    if (va === vb) return a.id - b.id;   // a stable tiebreak, so rows never shuffle
    return (va > vb ? 1 : -1) * dir;
  });
}

/**
 * What a folder made by folding N cards is called. First few words of the
 * first card, then how many others came with it — enough to recognise the pile
 * without pretending to have read it.
 */
export function foldName(first: string, count: number): string {
  const head = (first || 'Untitled')
    .split(/[.,—:;\n]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');
  return count > 1 ? `${head} + ${count - 1}` : head;
}

/**
 * A folder's contents as roadmap PHASES, for Promote → Roadmap. Everything
 * named inside becomes one phase, in the order the folder shows them; the
 * promote dialog is where the owner edits them, so guessing more structure than
 * "these are the parts" would only be more to undo. Buckets are left at
 * `should` for the same reason: a machine-set bucket is a claim about necessity
 * that nobody made.
 *
 * An EMPTY folder promotes as a single phase named after itself rather than as
 * nothing — a promote that silently produced no phases reads as a button that
 * did not work.
 */
export function phasesOf(
  cards: WorkbenchCard[], id: FolderId, folderName: string,
): { n: string; t: string; d: string; gate: string; bucket: 'should' }[] {
  const inside = childrenOf(cards, id)
    .filter((c) => c.title.trim())
    .map((c, i) => ({
      n: String(i + 1),
      t: c.title.trim().slice(0, 200),
      d: '',
      gate: '',
      bucket: 'should' as const,
    }));
  if (inside.length) return inside;
  return [{ n: '1', t: `${folderName} — single phase`, d: '', gate: '', bucket: 'should' as const }];
}
