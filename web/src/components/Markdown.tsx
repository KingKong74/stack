// A SMALL MARKDOWN READER for agent-authored text (a plan-mode plan). It
// builds React elements and never sets HTML, so nothing in the text can inject
// markup — which is the whole reason it is hand-rolled rather than a library
// piped through dangerouslySetInnerHTML.
//
// It covers what Claude writes in a plan: headings, paragraphs, flat and
// indented lists, task boxes, fenced code, block quotes, pipe tables and rules;
// inline code, bold, italic and links. Anything else reads as its own text,
// which is the failure a reader can live with.
//
// A LINK IS TEXT, NOT AN ANCHOR. The root rule is that an agent-authored link
// is reduced to a same-origin path before rendering; a plan's links point off
// site, so the label is drawn and the target sits in its title, where a human
// can read it before choosing to go there by hand.

import type { ReactNode } from 'react';
import { parseBlocks } from '../lib/markdown';

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = n++;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{inline(m[5] ?? m[6])}</em>);
    else out.push(<span key={key} className="md-link" title={m[8]}>{inline(m[7])}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        switch (b.k) {
          case 'h': {
            const H = `h${Math.min(6, b.level + 1)}` as 'h2';   // the page owns h1
            return <H key={i}>{inline(b.text)}</H>;
          }
          case 'p': return <p key={i}>{inline(b.text)}</p>;
          case 'code': return <pre key={i}><code>{b.text}</code></pre>;
          case 'quote': return <blockquote key={i}>{inline(b.text)}</blockquote>;
          case 'hr': return <hr key={i} />;
          case 'table': return (
            <div key={i} className="md-table">
              <table>
                <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => (
                  <tr key={j}>{b.head.map((_, k) => <td key={k}>{inline(r[k] ?? '')}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          );
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul';
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.box === null ? undefined : 'task'} style={it.depth ? { marginLeft: `${it.depth * 1.25}em` } : undefined}>
                    {it.box !== null && <span className={`md-box${it.box ? ' on' : ''}`} aria-label={it.box ? 'done' : 'not done'}>{it.box ? '✓' : ''}</span>}
                    {inline(it.text)}
                  </li>
                ))}
              </L>
            );
          }
        }
      })}
    </div>
  );
}
