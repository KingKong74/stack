import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';

// Minimal markdown-ish renderer — bold, inline code, bullet lists, line breaks.
// Builds React nodes, never injects raw HTML. Used for refine_note display.
//
// Supported syntax:
//   **text**    → <strong>
//   `code`      → <code>
//   - item      → <ul><li>
//   blank line  → paragraph break (double newline)
//   single \n   → <br />

function escapeText(s: string): string {
  // No-op: React text nodes are always safe — just return the string.
  return s;
}

// Parse a single inline run (no newlines) into React nodes.
function parseInline(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < line.length) {
    // **bold**
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end !== -1) {
        nodes.push(createElement('strong', { key: i }, escapeText(line.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }
    // `code`
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end !== -1) {
        nodes.push(createElement('code', { key: i }, escapeText(line.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    // Accumulate plain text until the next special char.
    let j = i + 1;
    while (j < line.length && line[j] !== '*' && line[j] !== '`') j++;
    nodes.push(escapeText(line.slice(i, j)));
    i = j;
  }
  return nodes;
}

// Render a markdown-lite string into a React node tree.
// Paragraphs are separated by blank lines; bullet lists are prefixed with "- ".
export function renderMarkdownLite(text: string): ReactNode {
  const lines = text.split('\n');
  const result: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let paraLines: ReactNode[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      result.push(createElement('ul', { key: key++ }, ...listItems));
      listItems = [];
    }
  };

  const flushPara = () => {
    if (paraLines.length > 0) {
      result.push(createElement('p', { key: key++ }, ...paraLines));
      paraLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Blank line → flush current para/list
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }

    // Bullet item: "- " or "* " prefix
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const content = line.replace(/^[-*]\s+/, '');
      listItems.push(createElement('li', { key: i }, ...parseInline(content)));
      continue;
    }

    // Regular text line — flush any open list first
    flushList();

    // Add a <br /> between consecutive lines in the same paragraph
    if (paraLines.length > 0) {
      paraLines.push(createElement('br', { key: `br${i}` }));
    }
    paraLines.push(...parseInline(line));
  }

  flushPara();
  flushList();

  if (result.length === 0) return null;
  if (result.length === 1) return result[0];
  return createElement(Fragment, null, ...result);
}
