// THE ARCHITECTURE DOC, READ AS A PAGE (design: Architecture.dc.html). The
// doc stays one markdown `architecture` artifact, written and edited as text;
// this turns its blocks into the design's parts so it reads as a map, not a
// wall of prose. Pure and JSX-free so it runs under Node (scripts/archdoc.test.mjs).
//
// The shapes are CONVENTIONS a writer can see in the source, never hidden
// syntax, and each falls back to plain markdown when it does not fit:
//   • `# H1` is the page's title and is dropped; the paragraph(s) before the
//     first `## H2` are the lede.
//   • each `## H2` is a numbered section (01, 02 …).
//   • a bullet list whose every item opens with `**Label**` → cards. A label
//     that looks like a path (`web/`, `schema.sql`) draws in mono.
//   • an ordered list whose every item opens with `**Label**` → step cards.
//   • a paragraph opening `**Open question …**` (or Note / Warning / Caution) → a callout.
//   • a ```map fence → the system map (its line grammar is parseMap's).
//   • a ```deps fence → grouped chips: `Group: Name (note), Name (note)`;
//     a `note: …` line is the footer.
//   • a section that is only paragraphs → a panel; a paragraph that is only
//     `code` spans → a chip row; `**Title** · tag` as its first line → a
//     title with a tag.
// Tables, deps and panels are HALF-width: one pairs with the section before
// it, so two short sections share a row as the design draws them.

import { parseBlocks, type Block } from './markdown';

export type Card = { label: string; text: string; path: boolean };
export type MapNode = { kind: string; name: string; sub: string; accent: boolean };
export type SysMap = {
  row: ({ k: 'node'; node: MapNode } | { k: 'link'; label: string })[];
  band: string;
  groups: { title: string; caption: string; procs: { name: string; path: string; detail: string }[] }[];
};
export type Deps = { groups: { group: string; items: { name: string; note: string }[] }[]; note: string };
export type Part =
  | { k: 'cards'; cards: Card[] }
  | { k: 'steps'; steps: Card[] }
  | { k: 'callout'; label: string; text: string }
  | { k: 'map'; map: SysMap }
  | { k: 'deps'; deps: Deps }
  | { k: 'panel'; title: string; tag: string; paras: string[]; chips: string[] }
  | { k: 'block'; block: Block };
export type Section = { n: number; title: string; parts: Part[]; half: boolean };
export type ArchDoc = { lede: Block[]; sections: Section[] };
/** Rows of the page: one full section, or two half ones side by side. */
export type ArchRow = Section[];

const LEAD = /^\*\*(.+?)\*\*\s*(.*)$/;
const CALLOUT = /^\*\*((?:open question|note|warning|caution)\b)\s*([^*]*?)\*\*\s*(.*)$/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `**Label**: text` → a card; null when the item does not open with bold. */
function leadOf(text: string): Card | null {
  const m = text.match(LEAD);
  if (!m) return null;
  const label = m[1].replace(/[:.]\s*$/, '').trim();
  // `**web/**: the host…` reads as a sentence of its own on a card; `**Docs**
  // are artifacts` runs on from its label, so keeps its case.
  const sep = /[:.]\s*$/.test(m[1]) || /^[:.\-–—]/.test(m[2]);
  const rest = m[2].replace(/^[:.\-–—]\s*/, '').trim();
  return { label, text: sep ? cap(rest) : rest, path: !/\s/.test(label) && /[/.]/.test(label) };
}

const split = (s: string) => s.split('|').map((x) => x.trim());

/** The ```map grammar, one line each (anything else is ignored):
 *    node  Kind | Name | sub        (`node!` draws it in the accent)
 *    link  LABEL                    (the arrow to the next node; label optional)
 *    band  TEXT                     (the badge on the divider under the row)
 *    group Title | caption          (a dashed group below)
 *    proc  Name | path | detail     (a card in the latest group)
 *  Null when there is no node: the fence then draws as plain code. */
export function parseMap(text: string): SysMap | null {
  const map: SysMap = { row: [], band: '', groups: [] };
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^(node!?|link|band|group|proc)(?=\s|$)\s*(.*)$/);
    if (!m) continue;
    const [kw, rest] = [m[1], m[2]];
    if (kw.startsWith('node')) {
      const [kind = '', name = '', sub = ''] = split(rest);
      const last = map.row[map.row.length - 1];
      if (last && last.k === 'node') map.row.push({ k: 'link', label: '' });
      map.row.push({ k: 'node', node: { kind, name, sub, accent: kw === 'node!' } });
    } else if (kw === 'link') {
      if (map.row.length && map.row[map.row.length - 1].k === 'node') map.row.push({ k: 'link', label: rest });
    } else if (kw === 'band') map.band = rest;
    else if (kw === 'group') {
      const [title = '', caption = ''] = split(rest);
      map.groups.push({ title, caption, procs: [] });
    } else {
      const [name = '', path = '', ...detail] = split(rest);
      if (!map.groups.length) map.groups.push({ title: '', caption: '', procs: [] });
      map.groups[map.groups.length - 1].procs.push({ name, path, detail: detail.join(' | ') });
    }
  }
  while (map.row.length && map.row[map.row.length - 1].k === 'link') map.row.pop();
  return map.row.some((x) => x.k === 'node') ? map : null;
}

/** The ```deps grammar; null when no group parses. */
export function parseDeps(text: string): Deps | null {
  const deps: Deps = { groups: [], note: '' };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const note = line.match(/^note:\s*(.*)$/i);
    if (note) { deps.note = note[1]; continue; }
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const items = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const p = s.match(/^(.*?)\s*\(([^)]*)\)$/);
      return p ? { name: p[1], note: p[2] } : { name: s, note: '' };
    });
    deps.groups.push({ group: m[1].trim(), items });
  }
  return deps.groups.length ? deps : null;
}

const ONLY_CODE = /^(?:`[^`]+`\s*)+$/;

function partsOf(blocks: Block[]): Part[] {
  if (blocks.length && blocks.every((b) => b.k === 'p')) {
    const paras = (blocks as { k: 'p'; text: string }[]).map((b) => b.text);
    let title = '';
    let tag = '';
    const head = paras[0].match(/^\*\*([^*]+)\*\*\s*(?:·\s*(.+))?$/);
    if (head) { title = head[1]; tag = head[2] || ''; paras.shift(); }
    const chips: string[] = [];
    const prose = paras.filter((p) => {
      if (!ONLY_CODE.test(p)) return true;
      chips.push(...[...p.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
      return false;
    });
    return [{ k: 'panel', title, tag, paras: prose, chips }];
  }
  return blocks.map((b): Part => {
    if (b.k === 'list' && b.items.every((it) => it.depth === 0 && it.box === null)) {
      const cards = b.items.map((it) => leadOf(it.text));
      if (cards.every((c): c is Card => c !== null)) return b.ordered ? { k: 'steps', steps: cards } : { k: 'cards', cards };
    }
    if (b.k === 'p') {
      const c = b.text.match(CALLOUT);
      if (c) {
        const rest = [c[2].replace(/^[,;:\s]+/, '').replace(/[:.]\s*$/, ''), c[3]].filter(Boolean);
        const text = c[2].trim() ? `${cap(rest[0])}: ${rest.slice(1).join(' ')}` : c[3];
        return { k: 'callout', label: cap(c[1].toLowerCase()), text: text.trim() };
      }
    }
    if (b.k === 'code' && b.lang === 'map') { const map = parseMap(b.text); if (map) return { k: 'map', map }; }
    if (b.k === 'code' && b.lang === 'deps') { const deps = parseDeps(b.text); if (deps) return { k: 'deps', deps }; }
    return { k: 'block', block: b };
  });
}

export function parseArchDoc(src: string): ArchDoc {
  const blocks = parseBlocks(src);
  const lede: Block[] = [];
  const sections: Section[] = [];
  let cur: { title: string; blocks: Block[] } | null = null;
  const close = () => {
    if (!cur) return;
    const parts = partsOf(cur.blocks);
    const half = parts.length > 0 && parts.every((p) => p.k === 'deps' || p.k === 'panel' || (p.k === 'block' && p.block.k === 'table'));
    sections.push({ n: sections.length + 1, title: cur.title, parts, half });
  };
  blocks.forEach((b, i) => {
    if (b.k === 'h' && b.level === 1 && i === 0) return;
    if (b.k === 'h' && b.level === 2) { close(); cur = { title: b.text, blocks: [] }; return; }
    if (cur) cur.blocks.push(b); else lede.push(b);
  });
  close();
  return { lede, sections };
}

/** Pair each half section with the one before it, unless that one is a map
 *  or a set of steps, which want the full width. */
export function archRows(sections: Section[]): ArchRow[] {
  const rows: ArchRow[] = [];
  const wide = (s: Section) => s.parts.some((p) => p.k === 'map' || p.k === 'steps');
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const next = sections[i + 1];
    if (next && next.half && !wide(s)) { rows.push([s, next]); i++; } else rows.push([s]);
  }
  return rows;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
