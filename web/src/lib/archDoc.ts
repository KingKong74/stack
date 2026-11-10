// THE SPINE'S DOCS, READ AS PAGES (designs: Architecture.dc.html and
// Charter.dc.html). Each doc stays one markdown artifact, written and edited as text;
// this turns its blocks into the design's parts so it reads as a map, not a
// wall of prose. Pure and JSX-free so it runs under Node (scripts/archdoc.test.mjs).
//
// The shapes are CONVENTIONS a writer can see in the source, never hidden
// syntax, and each falls back to plain markdown when it does not fit:
//   • `# H1` is the page's title and is dropped; the paragraph(s) before the
//     first `## H2` are the lede.
//   • each `## H2` is a numbered section (01, 02 …); a trailing `(this
//     phase)` becomes a tag beside the title.
//   • a bullet list whose every item opens with `**Label**` → cards. A label
//     that looks like a path (`web/`, `schema.sql`) draws in mono; a leading
//     `_Eyebrow_` sits above the label; `**Label** (tag):` gives the card a tag.
//   • … and when every such label ENDS IN A FULL STOP (`**Resume is the
//     point.**`), the list is a principle per row: label left, text right.
//   • a bullet list where only SOME items open in bold → the bold ones as
//     cards, the rest as plain dash lines under them.
//   • an ordered list whose every item opens with `**Label**` → step cards when
//     every label is short (≤ 3 words), else numbered goals. A goal's text that
//     opens `a → b → c,` draws that run as a chain of chips.
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

export type Card = { label: string; text: string; path: boolean; eyebrow: string; tag: string };
export type Goal = Card & { chain: string[] };
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
  | { k: 'rows'; rows: Card[] }
  | { k: 'goals'; goals: Goal[] }
  | { k: 'mixed'; items: ({ k: 'card'; card: Card } | { k: 'line'; text: string })[] }
  | { k: 'callout'; label: string; text: string }
  | { k: 'map'; map: SysMap }
  | { k: 'deps'; deps: Deps }
  | { k: 'panel'; title: string; tag: string; paras: string[]; chips: string[] }
  | { k: 'block'; block: Block };
export type Section = { n: number; title: string; tag: string; parts: Part[]; half: boolean };
export type ArchDoc = { lede: Block[]; sections: Section[] };
/** Rows of the page: one full section, or two half ones side by side. */
export type ArchRow = Section[];

const LEAD = /^(?:_([^_]+)_\s+)?\*\*(.+?)\*\*\s*(.*)$/;
const CALLOUT = /^\*\*((?:open question|note|warning|caution)\b)\s*([^*]*?)\*\*\s*(.*)$/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `**Label**: text` → a card; null when the item does not open with bold. */
function leadOf(text: string): Card | null {
  const m = text.match(LEAD);
  if (!m) return null;
  const eyebrow = (m[1] || '').trim();
  const label = m[2].replace(/[:.]\s*$/, '').trim();
  let after = m[3];
  let tag = '';
  const t = after.match(/^\(([^)]+)\)\s*([:.\-–—].*)$/);
  if (t) { tag = t[1].trim(); after = t[2]; }
  // `**web/**: the host…` reads as a sentence of its own on a card; `**Docs**
  // are artifacts` runs on from its label, so keeps its case.
  const sep = /[:.]\s*$/.test(m[2]) || /^[:.\-–—]/.test(after);
  const rest = after.replace(/^[:.\-–—]\s*/, '').trim();
  return { label, text: sep ? cap(rest) : rest, path: !/\s/.test(label) && /[/.]/.test(label), eyebrow, tag };
}

/** The label as written, full stop kept: a principle reads as a sentence. */
const endsInStop = (text: string) => /^(?:_[^_]+_\s+)?\*\*[^*]*\.\*\*/.test(text);

/** `Commit → review → merge, with …` → the chain and the rest. Each link is a
 *  few plain words; anything else (code, brackets) is not a chain. */
export function chainOf(text: string): { chain: string[]; rest: string } {
  const m = text.match(/^((?:[A-Za-z][\w-]*(?: [\w-]+){0,2})(?:\s*→\s*[A-Za-z][\w-]*(?: [\w-]+){0,2}){2,})\s*[,.]\s*(.*)$/);
  if (!m) return { chain: [], rest: text };
  return { chain: m[1].split('→').map((x) => x.trim()), rest: cap(m[2]) };
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
      if (cards.every((c): c is Card => c !== null)) {
        if (b.ordered) {
          if (cards.every((c) => c.label.split(/\s+/).length <= 3)) return { k: 'steps', steps: cards };
          return { k: 'goals', goals: cards.map((c, i) => {
            const { chain, rest } = chainOf(c.text);
            return { ...c, label: b.items[i].text.match(LEAD)![2].trim(), chain, text: rest };   // a goal is a sentence: keep its stop
          }) };
        }
        if (b.items.every((it) => endsInStop(it.text))) {
          return { k: 'rows', rows: b.items.map((it, i) => ({ ...cards[i], label: it.text.match(LEAD)![2].trim() })) };
        }
        return { k: 'cards', cards };
      }
      if (!b.ordered && cards.some((c) => c !== null)) {
        return { k: 'mixed', items: b.items.map((it, i) => (cards[i] ? { k: 'card' as const, card: cards[i]! } : { k: 'line' as const, text: it.text })) };
      }
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
    const t = cur.title.match(/^(.*?)\s*\(([^)]+)\)$/);
    sections.push({ n: sections.length + 1, title: t ? t[1] : cur.title, tag: t ? cap(t[2]) : '', parts, half });
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

/** A MILESTONE'S GOAL, read as the design's goal and "Done when" (designs:
 *  Milestones.dc.html, the Charter's rail). The goal is one markdown field;
 *  a paragraph opening `Done when:` splits it. Text before it is the goal,
 *  that paragraph is the bar, and anything after it is `more` (a brief kept
 *  with the milestone), drawn below as plain markdown. No `Done when:` → it
 *  is all goal. */
export function splitGoal(src: string): { goal: string; done: string; more: string } {
  const paras = src.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const at = paras.findIndex((p) => /^\s*\**done when\**\s*:/i.test(p));
  if (at < 0) return { goal: src.trim(), done: '', more: '' };
  return {
    goal: paras.slice(0, at).join('\n\n').trim(),
    done: cap(paras[at].replace(/^\s*\**done when\**\s*:\**\s*/i, '').trim()),
    more: paras.slice(at + 1).join('\n\n').trim(),
  };
}
