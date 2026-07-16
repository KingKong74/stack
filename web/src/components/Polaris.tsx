import { useEffect, useRef, useState } from 'react';
import type { IntakeSuggestion, PolarisTurn } from '../store';

// Polaris — the Futures tab's Gemini terminal, under the north star box.
// Free chat grounded in the project's live state, plus the /sort flow that
// replaced the Roadmap tab's Intake panel: dump ideas, review the proposed
// destinations, apply. Gemini proposes, the human disposes — nothing lands
// until an explicit `apply`.
type Line = { role: 'you' | 'polaris' | 'sys'; text: string };

const HELP = [
  'polaris — a Gemini terminal pinned to this project.',
  'Anything you type is a question for it (it can see the north star,',
  'the open roadmap, the idea funnel and the bug count).',
  '',
  'commands:',
  '  /sort <ideas…>   sort a dump into MoSCoW/Futures (one idea per line,',
  '                   shift+enter for new lines) — then review with:',
  '  apply [n n…]     add all proposals, or just the numbered ones',
  '  move <n> <dest>  re-aim one (must/should/could/wont/future)',
  '  drop <n>         bin one proposal',
  '  /clear           wipe the screen',
].join('\n');

const DESTS = ['must', 'should', 'could', 'wont', 'future'] as const;

export function Polaris({
  onChat, onSort, onApply,
}: {
  onChat: (message: string, history: PolarisTurn[]) => Promise<string>;
  onSort: (text: string) => Promise<IntakeSuggestion[]>;
  onApply: (items: IntakeSuggestion[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    { role: 'polaris', text: "✦ Polaris online. Ask me anything about this project — or type /help." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<IntakeSuggestion[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, busy, open]);

  const say = (...added: Line[]) =>
    setLines((cur) => [...cur, ...added].slice(-200)); // scrollback cap

  const proposalText = (items: IntakeSuggestion[]) =>
    items.map((it, i) =>
      `${i + 1}. [${it.dest}${it.alignment ? ` · ${it.alignment}` : ''}] ${it.title}${it.why ? `\n   ✦ ${it.why}` : ''}`
    ).join('\n');

  const run = async () => {
    const raw = input.trim();
    if (!raw || busy) return;
    setInput('');
    say({ role: 'you', text: raw });

    // local commands first
    if (raw === '/help' || raw === 'help') { say({ role: 'sys', text: HELP }); return; }
    if (raw === '/clear') { setLines([]); setPending(null); return; }

    const sortMatch = raw.match(/^\/(sort|intake)\s*([\s\S]*)$/);
    if (sortMatch) {
      const dump = sortMatch[2].trim();
      if (!dump) { say({ role: 'sys', text: 'usage: /sort <your ideas — one per line>' }); return; }
      setBusy(true);
      try {
        const items = await onSort(dump);
        setPending(items);
        say({ role: 'polaris', text: `proposed destinations:\n${proposalText(items)}\n\napply · apply 1 3 · move 2 could · drop 1` });
      } catch (e) {
        say({ role: 'sys', text: `✗ ${(e as Error)?.message || 'sorting failed.'}` });
      } finally { setBusy(false); }
      return;
    }

    if (pending) {
      const applyMatch = raw.match(/^apply\s*((?:\d+[\s,]*)*)$/i);
      if (applyMatch) {
        const picks = (applyMatch[1].match(/\d+/g) || []).map(Number);
        const chosen = picks.length ? pending.filter((_, i) => picks.includes(i + 1)) : pending;
        if (!chosen.length) { say({ role: 'sys', text: 'nothing matched those numbers.' }); return; }
        setBusy(true);
        try {
          await onApply(chosen);
          const rest = pending.filter((it) => !chosen.includes(it));
          setPending(rest.length ? rest : null);
          const road = chosen.filter((it) => it.dest !== 'future').length;
          say({ role: 'polaris', text: `✓ added ${chosen.length} item${chosen.length === 1 ? '' : 's'} (${road} roadmap, ${chosen.length - road} futures)${rest.length ? ` — ${rest.length} still pending` : ''}` });
        } catch (e) {
          say({ role: 'sys', text: `✗ ${(e as Error)?.message || 'could not add the items.'}` });
        } finally { setBusy(false); }
        return;
      }
      const moveMatch = raw.match(/^move\s+(\d+)\s+(\S+)$/i);
      if (moveMatch) {
        const i = Number(moveMatch[1]) - 1;
        const dest = moveMatch[2].toLowerCase() as IntakeSuggestion['dest'];
        if (!pending[i] || !DESTS.includes(dest)) {
          say({ role: 'sys', text: `usage: move <n> <${DESTS.join('|')}>` });
          return;
        }
        const next = pending.map((it, j) => (j === i ? { ...it, dest, alignment: dest === 'future' ? it.alignment : null } : it));
        setPending(next);
        say({ role: 'polaris', text: proposalText(next) });
        return;
      }
      const dropMatch = raw.match(/^drop\s+(\d+)$/i);
      if (dropMatch) {
        const i = Number(dropMatch[1]) - 1;
        if (!pending[i]) { say({ role: 'sys', text: 'no such proposal.' }); return; }
        const next = pending.filter((_, j) => j !== i);
        setPending(next.length ? next : null);
        say({ role: 'polaris', text: next.length ? proposalText(next) : 'all proposals binned.' });
        return;
      }
    }

    // everything else is a question for Gemini
    setBusy(true);
    try {
      const history = lines.filter((l): l is Line & { role: 'you' | 'polaris' } => l.role !== 'sys').slice(-12);
      const reply = await onChat(raw, history);
      say({ role: 'polaris', text: reply });
    } catch (e) {
      say({ role: 'sys', text: `✗ ${(e as Error)?.message || 'Gemini call failed.'}` });
    } finally { setBusy(false); }
  };

  return (
    <div className={`polaris ${open ? 'open' : ''}`}>
      <button className="polaris-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="polaris-glyph">✦</span>
        <span className="polaris-name">Polaris</span>
        <span className="polaris-sub">Gemini terminal — ask anything, or /sort a pile of ideas</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="polaris-body" onClick={() => inputRef.current?.focus()}>
          <div className="polaris-scroll" ref={scrollRef}>
            {lines.map((l, i) => (
              <div className={`polaris-line ${l.role}`} key={i}>
                <span className="p-prompt">{l.role === 'you' ? '❯' : l.role === 'polaris' ? '✦' : '·'}</span>
                <span className="p-text">{l.text}</span>
              </div>
            ))}
            {busy && <div className="polaris-line polaris"><span className="p-prompt">✦</span><span className="p-text p-thinking">thinking…</span></div>}
          </div>
          <div className="polaris-input">
            <span className="p-prompt">❯</span>
            <textarea
              ref={inputRef} value={input} rows={1} disabled={busy}
              placeholder={pending ? 'apply · move <n> <dest> · drop <n> — or keep talking' : 'ask, or /help'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
              }} />
          </div>
        </div>
      )}
    </div>
  );
}
