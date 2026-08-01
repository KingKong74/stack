import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchBody, WorkbenchCard } from '../types';

// The ◈ design section — half the gap between a Workbench thread and a real
// design pass. The ✧ ops are Gemini's and can turn a rough card into
// directions, phases, a counter-case; none of them can draw a screen. That
// work happens in a Claude session (a `./stack term` tab, Claude Code, or
// claude.ai's design system) and Stack takes no part in it here — no key, no
// request, no round trip. What this DOES do is compose the brief FROM the
// canvas, so the thread travels with one copy instead of being retyped by
// hand.

// A card's body, rendered to plain lines — the same reading whether the card
// is the subject or something attached to it. Absent fields contribute
// nothing, so an empty body is an empty list, never blank filler lines.
function bodyLines(body: WorkbenchBody): string[] {
  const out: string[] = [];
  if (body.question) out.push(`Asked: ${body.question}`);
  for (const l of body.lines || []) out.push(`${l.mk} ${l.t}`);
  for (const p of body.phases || []) {
    out.push(`${p.n}. ${p.t} — ${p.d}`);
    if (p.gate) out.push(`gate: ${p.gate}`);
  }
  if (body.chips && body.chips.length) out.push(body.chips.join(' · '));
  return out;
}

// The same expression Workbench.tsx uses to label a card's kind — kept here
// too because the subject card arrives on its own, not as a lineage entry.
const kindLabel = (c: WorkbenchCard) =>
  (c.kind === 'polaris' ? c.meta : c.kind === 'note' ? 'note' : (c.op || 'ai'));

// Pure — no React, no network. Markdown out, nothing else.
export function composeDesignBrief(
  slug: string,
  card: WorkbenchCard,
  lineage: { card: WorkbenchCard; depth: number; kind: string }[],
  ask: string,
): string {
  const header = `# Design brief — ${slug}\n`
    + `Composed on Stack's Workbench. Everything below is the thread as it stands on the canvas.`;

  const subjectLines = [`${kindLabel(card)} · ${card.title}`, ...bodyLines(card.body)];
  const sections = [header, `## Subject\n${subjectLines.join('\n')}`];

  if (lineage.length) {
    const attachedLines: string[] = [];
    for (const entry of lineage) {
      const indent = '  '.repeat(Math.max(0, entry.depth - 1));
      attachedLines.push(`${indent}- ${entry.kind} · ${entry.card.title}`);
      for (const bl of bodyLines(entry.card.body)) attachedLines.push(`${indent}  ${bl}`);
    }
    sections.push(`## Attached · ${lineage.length}\n${attachedLines.join('\n')}`);
  }

  const trimmedAsk = ask.trim();
  if (trimmedAsk) sections.push(`## The ask\n${trimmedAsk}`);

  return sections.join('\n\n');
}

export function WorkbenchDesign({ card, slug, lineage, onSay }: {
  card: WorkbenchCard | null;
  slug: string;
  lineage: { card: WorkbenchCard; depth: number; kind: string }[];
  onSay: (t: string) => void;
}): JSX.Element {
  // Kept per-card rather than reset on selection change: the ask is the
  // human's steer, not the card's, so switching cards shouldn't lose it.
  const [ask, setAsk] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const brief = useMemo(() => (card ? composeDesignBrief(slug, card, lineage, ask) : ''),
    [slug, card, lineage, ask]);
  const words = useMemo(() => (brief.trim() ? brief.trim().split(/\s+/).length : 0), [brief]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      onSay(`Design brief copied — ${words} words, ${lineage.length} attached.`);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      onSay('Could not reach the clipboard — the brief was not copied.');
    }
  };

  return (
    <div className="wb-design">
      <div className="row"><span className="k">◈ design</span><span className="note">Claude, by hand</span></div>
      {!card ? (
        <div className="none">Pick a card. The brief is built from it and everything attached to it.</div>
      ) : (
        <>
          <textarea className="ask" rows={2} value={ask} onChange={(e) => setAsk(e.target.value)}
            placeholder="What to ask for — a screen, its states, the empty case…" />
          <div className="count">subject + {lineage.length} attached · {words} words</div>
          <button className="wb-copy" onClick={() => void copy()} disabled={copied}>
            {copied ? '✓ copied' : '⧉ Copy design brief'}
          </button>
          <div className="hint">
            Stack doesn't call Claude here — no key, no round trip. Paste this into a Claude session
            (a <code>./stack term</code> tab, or claude.ai's design system) and bring the design back
            onto the canvas.
          </div>
        </>
      )}
    </div>
  );
}
