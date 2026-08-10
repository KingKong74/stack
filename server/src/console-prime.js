// THE CONSOLE PRIME (#380) — the system prompt that makes a tab agent's live
// session that agent, rather than a bare `claude` in a checkout.
//
// #379 gave four project tabs a console: `cmd: 'claude'` in the project's own
// directory, in tmux on the host. It was a plain session that happened to be
// drawn on the Auditor's tab. Every one of them opened knowing nothing about
// the tab it was opened from, so the first thing the owner did in it was type
// the paragraph the tab was already showing — which is precisely the cost the
// consoles were added to remove.
//
// So the session is SPAWNED primed: the daemon writes this text to a file and
// runs `claude --append-system-prompt "$(cat …)"`. Three consequences worth
// stating, because they are why this is a system prompt and not a pasted brief:
//
//  • IT NEEDS NO ENTER. Stack's rule everywhere else is that nothing is typed
//    into a session and run for you (see the Terminal screen's brief paste).
//    A system prompt is not typing: it is how the session is spawned, so the
//    agent is itself from turn zero and the owner's first message is theirs.
//  • IT SURVIVES THE CONVERSATION. A pasted brief is turn one and slides out of
//    the window; the identity is in every turn for as long as the session runs.
//  • IT PRODUCES NO OPENING TURN, and this is the thing to get right before
//    writing a word of it. A system prompt is not a message: `claude` spawns
//    with it and then WAITS, so nothing is said until the owner types. A prime
//    that instructs the agent to "open with…" is really instructing it about
//    whatever the owner's first message turns out to be — which is why the text
//    below branches on what that message IS, and why the menu of openers is
//    drawn by the strip (TabTerminal.tsx) rather than left to a turn that never
//    happens. Drive it and look, or this reads as working and does nothing.
//  • IT IS A SNAPSHOT AND SAYS SO. The state below is read once, when the
//    session is spawned, and the session can run for hours — so the text tells
//    the model it is stale by construction and that Stack's API is the truth.
//    Without that line an agent confidently reports last Tuesday's failing
//    check as the live one.
//
// This module is PURE and DB-free (the same split as debrief.js and lanes.js):
// the route gathers the rows, this composes the words, and
// `server/test/console-prime.test.mjs` runs it directly. What the tabs actually
// put in the sections lives in `routes/console.js`.

// The whole prompt is capped, and the cut is STATED (the #239 rule: a capped
// list inside a prompt must say it is capped, and on the right axis). An
// agent whose snapshot was silently truncated answers about the half it saw
// as though it were the whole.
export const PRIME_CAP = 7000;

// One section of the snapshot. `lines` empty is a real answer — "nothing here
// right now" — and is rendered as one, never dropped: an absent section reads
// as "not shown", and the two must not look alike (the NULL-verdict rule).
// `note` is where a section says what it left out.
function renderSection({ title, lines, note }) {
  const body = (lines || []).length
    ? (lines || []).map((l) => `  - ${l}`).join('\n')
    : '  - nothing here right now';
  return `${title}\n${body}${note ? `\n  (${note})` : ''}`;
}

// THE OPENERS, numbered. The list is the registry's (`agents.js` — one
// definition, drawn as buttons on the strip and printed here), and the NUMBERS
// are the contract between the two: the owner sees them in this order beside
// the console, so a bare "2" typed at the prompt has to mean the same thing to
// the agent. An agent with no openers gets no block at all rather than an empty
// heading — there is nothing to be told, and a heading over nothing reads as a
// list that failed to load.
function renderOpeners(openers) {
  const list = (openers || []).filter((o) => o && o.label && o.ask);
  if (!list.length) return '';
  const lines = list.map((o, i) => `  ${i + 1}. ${o.label} — ${o.ask}`).join('\n');
  return `\n\nWHAT THIS SURFACE IS USUALLY OPENED FOR
The owner has these as buttons beside this session, in this order, and pressing one types its ask at
your prompt. They may also just answer with the number, and that means this list:

${lines}`;
}

export function consolePrime({ agent, guidance, project, sections, openers }) {
  const steer = String(guidance || '').trim();
  const name = project?.name || project?.slug || 'this project';
  const surface = `${agent.tabLabel} ${agent.surface || 'tab'}`;

  const head = `You are ${agent.name}, one of Stack's agents, and THIS SESSION IS YOU.

It was opened from the ${surface} of "${name}" (slug: ${project?.slug || ''}) in Stack, and it runs in
that project's own checkout on the host. The ✧ buttons on that surface ask you one question and take
one JSON answer back; this is the other half — a full session the owner types into, so you can read
the code, run things, change them and commit, exactly as any session in this checkout could.

What does not change is your remit: ${agent.remit}. That is what you are for here.
Work that belongs to another of Stack's agents is not forbidden to you — the owner is the director
and this is their session — but say whose it is in one sentence before you do it, so they know they
have left the surface they opened.

YOUR FIRST REPLY. You are spawned and then you wait — the owner speaks first, so there is no
greeting to make. What they say first decides which of these you do:
  • A BARE NUMBER (or a name from the list below) is the whole instruction: it means that item in
    "WHAT THIS SURFACE IS USUALLY OPENED FOR", and the owner pressed a button to send it. Do it.
  • NOTHING IN PARTICULAR — "hi", "what's here", "where do I start" — is asking for the menu.
    Answer with that numbered list, the same numbers in the same order, one short line each: the
    label, and what it would get them given the snapshot. Say a bare number picks one. Then stop:
    that is a menu, not permission, so do not start any of it. If there is no such list below, say
    in one line what this surface is worth asking you for right now, drawn from the snapshot.
  • ANYTHING ELSE is the work. Answer it, and open with one line saying who you are and what you
    are about to do.
In every case: do not start work nobody has asked for.`;

  const steerBlock = steer ? `\n\nSTANDING GUIDANCE FROM THE OWNER (follow it):\n${steer}` : '';

  const snapshot = `\n\nWHAT THE ${surface.toUpperCase()} SHOWED WHEN THIS SESSION OPENED
This is a SNAPSHOT, taken once as you were spawned, and this session may run for hours. Stack's own
API and this checkout are the truth; re-read them before you act on anything below, and never report
a line of it as the live state.

${(sections || []).map(renderSection).join('\n\n')}`;

  // The openers sit BEFORE the snapshot on purpose: the cut below takes the
  // TAIL, and this list is what a bare "2" at the prompt resolves against — a
  // briefing that lost its menu to a long board would answer a button press
  // with "which one?". The snapshot degrades gracefully; the menu does not.
  const full = `${head}${steerBlock}${renderOpeners(openers)}${snapshot}\n`;
  if (full.length <= PRIME_CAP) return full;
  return `${full.slice(0, PRIME_CAP)}\n\n[This briefing was cut at ${PRIME_CAP} characters — the snapshot above is incomplete, and what is missing is the TAIL of it. Read the live state rather than assuming you have seen everything.]\n`;
}
