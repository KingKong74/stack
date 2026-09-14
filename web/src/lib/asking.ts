import type { BlockedPrompt, DetachedSession } from '../store';

// WHICH SESSIONS HAVE STOPPED TO ASK YOU SOMETHING — the pure half.
//
// A claude session sitting on a permission prompt is the most time-sensitive
// thing Stack knows: every second it waits is a second nothing is happening.
// The daemon already reports it (`blocked`, re-pushed within twenty seconds of
// a prompt appearing — `watchBlocks` in terminal/stack-term.mjs), and the
// Terminal screen has always drawn it on its own rail. This is what lets every
// OTHER screen say it too; components/Asking.tsx holds the poll and the two
// surfaces, and its header carries why they do not overlap.
//
// PURE ON PURPOSE, and not just for tidiness: the sort order and the name
// fallback below are the two things a surface would get quietly wrong, and a
// module importing react and store.ts is a module `scripts/asking.test.mjs`
// cannot load. The type imports are erased, so this file pulls in nothing.
//
// IT LEANS TOWARDS NULL exactly as `terminal/prompt-scan.mjs` does: a false
// positive puts a pulsing badge in the topbar over a question nobody asked,
// which is worse than noticing a real one a tick late. Nothing here ever
// promotes a session to "asking" on its own — it only passes through what the
// host's own scan already decided.

export type AskingSession = {
  /** The host tmux session name — the one id every surface agrees on. */
  name: string;
  /** Jail-relative cwd ('' = the $HOME root); what a re-attach link needs. */
  cwd: string;
  /** ✧ Gemini's take on what it is doing. '' when nothing has named it yet. */
  label: string;
  /** The question itself, with `since` stamped by the relay. */
  ask: BlockedPrompt;
};

/**
 * The waiting sessions out of the host's full session list, LONGEST WAIT
 * FIRST.
 *
 * The order is the whole reason this is a function rather than a `.filter()`
 * at each call site. A prompt that has been up since last night and one that
 * appeared while you were reading this are the same sentence and very
 * different problems, and with the list capped by the height of a rail it is
 * the order — not the ages — that decides which one you are shown at all.
 *
 * GET /api/terminal/detached is the input, and despite its name it advertises
 * EVERY `stack-term-*` session, attached or not. That is deliberate here: a
 * session someone is attached to elsewhere (a laptop over ssh, a second
 * browser) can be just as stopped as an orphan, and dropping it would make the
 * count disagree with the terminal rail's.
 */
export function pickAsking(sessions: DetachedSession[]): AskingSession[] {
  const out: AskingSession[] = [];
  for (const d of sessions) {
    if (!d.blocked) continue;
    out.push({ name: d.name, cwd: d.cwd || '', label: d.label || '', ask: d.blocked });
  }
  return out.sort((a, b) => a.ask.since - b.ask.since || a.name.localeCompare(b.name));
}

/**
 * HOW LONG IT HAS BEEN WAITING, from the relay's `since` stamp. Not `timeAgo`:
 * that formats a past event ("4m ago") and this is a duration still running —
 * "4m" is a wait, "4m ago" reads as something that finished.
 *
 * The relay stamps the first push carrying a fingerprint and deliberately does
 * not persist it, so after a relay restart this says "at least this long"
 * rather than inventing a history. Which is why the floor reads `<1m` and
 * never a precise zero: a prompt Stack has only just noticed is not a prompt
 * that has only just appeared.
 */
export function waitedFor(since: number, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - since) / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * What to CALL a session in a list. The ✧ label if one has landed, else the
 * directory it is working in, else the jail root.
 *
 * NEVER THE TMUX NAME, which is eight hex characters and names nothing. And
 * the label is usually ABSENT here: only the Terminal screen asks Gemini for
 * those, so a browser that has not been there this session has none at all —
 * the cwd fallback is the common case, not the edge one.
 */
export function askingName(a: AskingSession): string {
  if (a.label) return a.label;
  const leaf = a.cwd.split('/').filter(Boolean).pop();
  return leaf || 'home';
}
