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

export function WorkbenchDesign({ card, slug, lineage, onSay, onPasteBack }: {
  card: WorkbenchCard | null;
  slug: string;
  lineage: { card: WorkbenchCard; depth: number; kind: string }[];
  onSay: (t: string) => void;
  onPasteBack: (text: string) => Promise<void>;
}): JSX.Element {
  // Kept per-card rather than reset on selection change: the ask is the
  // human's steer, not the card's, so switching cards shouldn't lose it.
  const [ask, setAsk] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The return leg. What comes back is the human's own words — Stack has no
  // `ai` card the client is allowed to write, and even if it did, a design
  // pasted from elsewhere isn't Gemini's output to own. It lands as a note,
  // the same kind ⌘K already finds and → Bug / → Roadmap already promotes.
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // `ask` persists ACROSS a change of selection on purpose — it is the human's
  // standing steer, not the card's. A half-typed paste is the opposite: it is
  // aimed at ONE card, and carrying it to whatever gets clicked next would wire
  // a design to the wrong subject silently, while the placeholder still says
  // "wired to this card". Same reasoning as the pull picker's closePicker
  // dropping its ticks. Keyed on `card?.id` alone — NOT on `busy` — because
  // this only ever needs to fire on a change of selection; putting `busy` in
  // the deps would re-run it the moment a submit finishes, including a FAILED
  // one, and clear the very paste the failure path above is keeping on screen.
  // `busy` is read, not depended on: the guard just skips the one case where a
  // card change lands mid-submit.
  useEffect(() => {
    if (busy) return;
    setPasting(false);
    setPaste('');
  }, [card?.id]);

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

  const cancelPaste = () => { setPasting(false); setPaste(''); };

  const submitPaste = async () => {
    const text = paste.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onPasteBack(text);
      // Workbench's own guard reports a failure; resolving here is not proof
      // the card landed, only that nothing THREW — so only clear on that path,
      // never lose a paste the human just made to a swallowed error.
      setPaste('');
      setPasting(false);
    } finally {
      setBusy(false);
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

          {!pasting ? (
            <button className="chip-sm" onClick={() => setPasting(true)}>⌦ Paste a design back</button>
          ) : (
            <>
              <textarea className="ask" rows={4} autoFocus value={paste}
                placeholder="Paste the design here — it lands as a note wired to this card."
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submitPaste(); }
                  else if (e.key === 'Escape') {
                    // Workbench's own window-level keydown handler treats Esc as a
                    // chain that ends in deselecting the card — and deselecting
                    // unmounts this whole section, box and all. That chain has no
                    // idea this box exists, so it can't be taught to skip it; the
                    // box has to claim the key itself while it holds the cursor,
                    // stopping the bubble rather than merely preventing the
                    // textarea's own default. Esc here means cancel-this-paste,
                    // full stop.
                    e.preventDefault();
                    e.stopPropagation();
                    cancelPaste();
                  }
                }} />
              <div className="pasterow">
                <button className="wb-copy" disabled={!paste.trim() || busy} onClick={() => void submitPaste()}>
                  {busy ? 'adding…' : 'Add to canvas'}
                </button>
                <button className="chip-sm" onClick={cancelPaste}>cancel</button>
              </div>
              <div className="pastehint">⌘⏎ to add · Esc to cancel</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
