// The block half of components/Markdown.tsx: markdown source → a flat list of
// blocks. Pure and JSX-free so it runs under Node (scripts/markdown.test.mjs);
// the component's header says what is covered and why it is hand-rolled.

export type Block =
  | { k: 'h'; level: number; text: string }
  | { k: 'p'; text: string }
  | { k: 'code'; lang: string; text: string }
  | { k: 'quote'; text: string }
  | { k: 'hr' }
  | { k: 'list'; ordered: boolean; items: { depth: number; text: string; box: null | boolean }[] }
  | { k: 'table'; head: string[]; rows: string[][] };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```+|~~~+)\s*(\S*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ k: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ k: 'h', level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '') }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ k: 'hr' }); i++; continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push({ k: 'table', head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ k: 'quote', text: body.join(' ') });
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: { depth: number; text: string; box: null | boolean }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          const box = m[3].match(/^\[([ xX])\]\s+(.*)$/);
          items.push({
            depth: Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2)),
            text: box ? box[2] : m[3],
            box: box ? box[1] !== ' ' : null,
          });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i++].trim()}`;   // a wrapped item
        } else break;
      }
      out.push({ k: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\|)/.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    if (!para.length) para.push(lines[i++].trim());
    out.push({ k: 'p', text: para.join(' ') });
  }
  return out;
}
