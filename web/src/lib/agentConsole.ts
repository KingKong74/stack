import type { TabAgentKey } from '../store';

// A TAB AGENT'S CONSOLE, NAMED (#379, #380) — the one place the session name is
// composed, and the one place it is read back.
//
// ---- composing ------------------------------------------------------------
//
// `stack-term-<agent key>-<project slug>`. Two consequences, both wanted:
//
//  • DETERMINISTIC, so it is one session. The Terminal screen generates a
//    random name per tab because its tabs are ad-hoc; a tab agent's console is
//    not — the Quality console of the "stack" project is a single thing, and
//    reloading the page, opening a second browser or coming back on the phone
//    must re-attach to it rather than leave three Claudes running against one
//    checkout. `tmux new-session -A` does the attach-or-create in one command.
//  • THE `stack-term-` PREFIX IS LOAD-BEARING. It is what puts the session on
//    the running-sessions strip, what the browser's mirror and kill paths list,
//    and what the idle reaper keys off (`termIdleHours`). All three are right
//    for a console: it is an attended Claude session like any other.
//
// A slug is `[a-z0-9-]` in practice, but it arrives from the URL, so it is
// sanitised and capped rather than trusted: the daemon's `validName` refuses
// anything outside `stack-[A-Za-z0-9_-]{1,64}` and would fail the start frame
// with no useful sentence for the owner.
//
// ---- reading it back ------------------------------------------------------
//
// #380 — the Terminal screen shows these sessions too (⤢ sends one there, and
// they sit in the detached strip like everything else), and a tab reading
// `claude · stack` for the Auditor's console is the screen refusing to say the
// one thing that distinguishes it from the four beside it. The name is the only
// evidence available there — the Terminal screen has no project payload and no
// agent state — so it is parsed back.
//
// The agent key is matched against THIS LIST rather than a `([a-z]+)` group, on
// purpose: `generateName('term')` produces `stack-term-<8 hex chars>`, and a
// pattern that accepted any word would read a random session as an agent's
// console and put somebody else's work under the Auditor's name.
//
// The names are duplicated from the server's registry (`server/src/agents.js`),
// which is the same arrangement `lib/branch.ts` has with `scripts/lib/lane.mjs`:
// none of the packages can import another, so the copy is kept in step by
// discipline. Adding a console to a fourth agent means adding it here.
export const CONSOLE_AGENTS: { key: TabAgentKey; name: string }[] = [
  { key: 'auditor', name: 'Auditor' },
  { key: 'curator', name: 'Curator' },
  { key: 'drafter', name: 'Drafter' },
];

export const consoleSessionName = (agentKey: TabAgentKey, slug: string) =>
  `stack-term-${agentKey}-${slug.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)}`;

export type ConsoleSession = { agentKey: TabAgentKey; agentName: string; slug: string };

// null = this is not a tab agent's console, which is the answer for every
// ordinary terminal session and must never be dressed up as one.
export function parseConsoleSession(name: string): ConsoleSession | null {
  const s = String(name || '');
  for (const a of CONSOLE_AGENTS) {
    const prefix = `stack-term-${a.key}-`;
    if (s.startsWith(prefix) && s.length > prefix.length) {
      return { agentKey: a.key, agentName: a.name, slug: s.slice(prefix.length) };
    }
  }
  return null;
}

// How a console is titled wherever it is shown away from its own tab: the agent
// FIRST, because that is what the owner is looking for, and the project after
// it, because the same agent has one of these per project.
export const consoleTitle = (c: ConsoleSession) => `${c.agentName} · ${c.slug}`;
