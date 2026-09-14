// termName — A SESSION IS NAMED BY WHAT YOU TYPED INTO IT (#512).
//
// The name of a terminal session used to be a reading of its OUTPUT: Gemini
// looked at the tail and paraphrased what the assistant had just said. #490
// stopped that re-asking, because a title that keeps changing is a status line
// rather than a name. This finishes the same thought from the other end. The
// one question a name answers is "which of these six terminals is the one I
// walked away from", and the answer you already hold is the thing you ASKED
// it — not the machine's summary of how it went.
//
// So the name is the FIRST thing the human sent, verbatim. That makes it:
//   free       — no model, no key, no 503; it is characters the browser
//                already had in its hand on the way to the socket.
//   instant    — the name is there the moment you press Enter, rather than
//                after the 2000 bytes of output the labeller had to wait for.
//   STABLE     — it is a fact about the past, so nothing can revise it. The
//                labeller's answer was a fact about the present, which is what
//                made "name it once" and "name it well" pull against each
//                other for two rounds of this feature.
//
// VERBATIM IS THE POINT, so nothing here title-cases, sentence-cases or
// otherwise improves the words: `npm run build`, `/checkpoint` and `why is the
// dispatcher skipping #477` are all exactly what the person meant and all three
// are wrecked by a capital. Whitespace is collapsed and the tail is cut,
// nothing else.
//
// WHY A LINE EDITOR AND NOT `chunk.split('\r')[0]`: the keystroke stream is
// what a terminal receives, not what a text field holds — backspaces, ⌃U, ⌃C,
// arrow keys and bracketed-paste wrappers are all in it, and a session named
// "ehco hello\x7f\x7f\x7fcho" is worse than an unnamed one. This replays the
// stream into a line the way the pty would, then takes the line.
//
// It does NOT follow the cursor: a left-arrow and then typing inserts at the
// end here and in the middle there. That is a deliberate floor — handling it
// means reimplementing readline for a string nobody reads twice, and the
// approximation is wrong only for someone who edits mid-line BEFORE their
// first Enter.

/** The in-flight line for one session. `done` latches: a session is named once.
 *  `esc` is the escape-sequence parser's state, and it lives on the capture
 *  rather than inside one call for the reason the first cut of this got wrong:
 *  A SEQUENCE IS NOT GUARANTEED TO ARRIVE WHOLE. xterm hands a keypress over
 *  as one chunk, but a paste, a fast typist and a slow socket all split the
 *  stream wherever they like — so a regex that strips ESC[D from a chunk is
 *  correct only until ESC and [D land in different ones, and then an arrow key
 *  is three characters of the session's name. Scanning character by character
 *  with the state carried across chunks has no such seam. */
export type TypedCapture = { buf: string; done: boolean; esc: EscState };

/** text — ordinary characters. esc — ESC seen, deciding what follows.
 *  csi — inside ESC[ … final, which is where arrow keys and BOTH bracketed
 *  paste markers (ESC[200~ / ESC[201~) live, so they cost no special case.
 *  osc — inside ESC] … BEL|ST, which a pasted string can carry. */
type EscState = 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc';

export const newCapture = (): TypedCapture => ({ buf: '', done: false, esc: 'text' });

/** The longest line we will hold before a submit. A pasted essay is still a
 *  name (its first words are), but the buffer must not grow without limit. */
const MAX_BUF = 400;

/** The longest name we render. Longer is cut on a word boundary with an
 *  ellipsis, so a rail row says where the sentence was going. */
const MAX_NAME = 60;

/**
 * Replay one chunk of the keystroke stream into the pending line.
 *
 * Returns the finished NAME when this chunk completed one (and latches `done`
 * so the session is never renamed), or null while there is still nothing worth
 * naming it. Mutates `st` — it is one session's cursor through its own stream.
 */
export function feedTyped(st: TypedCapture, chunk: string): string | null {
  if (st.done) return null;
  for (const ch of chunk) {
    // ---- the escape parser, ahead of everything: anything it is mid-way
    // through is a KEY, and a key contributes no characters at all.
    if (st.esc === 'esc') {
      if (ch === '[') st.esc = 'csi';
      else if (ch === ']') st.esc = 'osc';
      else st.esc = 'text';           // ESC + one byte (alt-chords, ESC O …)
      continue;
    }
    if (st.esc === 'csi') {
      // Parameter and intermediate bytes, then one final byte 0x40–0x7E ends
      // it — which is what swallows ESC[200~ and ESC[201~ whole.
      if (ch >= '@' && ch <= '~') st.esc = 'text';
      continue;
    }
    if (st.esc === 'osc') {
      if (ch === '\x07') st.esc = 'text';        // BEL terminates
      else if (ch === '\x1b') st.esc = 'oscEsc'; // …or ST, which is ESC \
      continue;
    }
    if (st.esc === 'oscEsc') { st.esc = ch === '\\' ? 'text' : 'osc'; continue; }
    if (ch === '\x1b') { st.esc = 'esc'; continue; }

    if (ch === '\r' || ch === '\n') {
      // A SUBMIT, which is not automatically a name. An empty line is how you
      // get past claude's own trust prompt and how a shell shows you a fresh
      // prompt, and `nameFrom` turns both into '' — so the line clears and the
      // capture stays open for the thing you actually came to ask.
      const name = nameFrom(st.buf);
      st.buf = '';
      if (name) { st.done = true; return name; }
      continue;
    }
    if (ch === '\x7f' || ch === '\b') { st.buf = st.buf.slice(0, -1); continue; }
    // ⌃C and ⌃U both abandon the line. ⌃W drops the last word, which is the
    // one editing key that is cheap to honour and common enough to matter.
    if (ch === '\x03' || ch === '\x15') { st.buf = ''; continue; }
    // ⌃W the way readline does it: skip back over trailing whitespace, drop
    // the word, and LEAVE THE SEPARATOR that preceded it. Collapsing both in
    // one pass is the obvious spelling and joins the retyped word to the one
    // before it — "fix the raiil" ⌃W "rail" came out "fix therail".
    if (ch === '\x17') { st.buf = st.buf.replace(/\s+$/, '').replace(/\S+$/, ''); continue; }
    if (ch === '\t') { st.buf += ' '; continue; }
    // Every other C0 control is a key, not a character.
    if (ch < ' ') continue;
    if (st.buf.length < MAX_BUF) st.buf += ch;
  }
  return null;
}

/**
 * The name a submitted line earns, or '' for one that earns none.
 *
 * THE TWO REFUSALS ARE THE WHOLE JUDGEMENT HERE, and both exist because the
 * first Enter of a claude session is usually not a question. Claude Code opens
 * on a trust prompt answered with a bare Enter or a single "1", and a shell
 * session opened and stared at emits a blank line for every Enter pressed at
 * it. Naming a terminal "1" for the rest of its life is worse than leaving it
 * unnamed, since unnamed is a state the screen already draws honestly and has
 * a fallback for.
 *
 * So: it must be at least three characters, and it must contain a letter. That
 * passes `ls`… no, it does not — and that is the right floor. A two-character
 * command is not what you walked away in the middle of.
 */
export function nameFrom(line: string): string {
  const s = line.replace(/\s+/g, ' ').trim();
  if (s.length < 3) return '';
  if (!/[A-Za-z]/.test(s)) return '';
  if (s.length <= MAX_NAME) return s;
  const cut = s.slice(0, MAX_NAME);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > MAX_NAME * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
}
