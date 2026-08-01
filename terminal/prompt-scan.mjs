// Is this session BLOCKED on a permission prompt right now?
//
// The one thing Mission Control could never see. A claude session that has
// stopped and is waiting for a human to say yes looks, from every signal Stack
// had, exactly like a session that is thinking hard: the tmux pane is alive,
// the transcript has stopped growing, presence is fresh. So the fleet reads as
// working while nothing is happening, sometimes for hours.
//
// The read is a pure function over the pane text the daemon ALREADY captures
// for the Gemini labeller (tmux-session.paneTail), so watching for a block
// costs no extra fork and no extra frame. Everything below is string work —
// which is what makes it testable without a tmux, a claude or a host:
//
//   node server/test/prompt-scan.test.mjs
//
// Autopilot sessions are out of scope BY CONSTRUCTION, not by omission: the
// runner passes --dangerously-skip-permissions, so it never prompts. Only
// interactive stack-term-* sessions can be blocked this way, and those are
// exactly the ones the daemon enumerates.

import { createHash } from 'node:crypto';

// A prompt option: "❯ 1. Yes" / "  2. Yes, and don't ask again for …".
// The leading ❯ (or >) is the cursor and may sit on any of them.
const OPTION_RE = /^(?:[❯>»]\s*)?(\d{1,2})\.\s+(\S.*)$/;

// The question line. Claude words it differently per tool — an edit, a bash
// command, a fetch, a folder trust check — but every one of them is a "do you
// want to" / "do you trust" sentence.
const QUESTION_RE = /\b(do you want to|do you trust|would you like to)\b/i;

// The box tmux is drawing the prompt inside. U+2500–U+257F is the whole
// box-drawing block; the half-blocks some themes use are listed after it.
const BOX_CHARS = '\\u2500-\\u257f\\u2588\\u258c\\u2590';
const LEAD_RE = new RegExp(`^[\\s${BOX_CHARS}]+`);
const TAIL_RE = new RegExp(`[\\s${BOX_CHARS}]+$`);
const BORDER_RE = new RegExp(`^[\\s${BOX_CHARS}]*$`);

// What may legitimately sit BELOW the last option: the keyboard hints Claude
// prints under the box. Anything else means the prompt has scrolled past and
// the session is no longer waiting on it.
const HINT_RE = /(esc|enter|↵|⏎|tab|shift|ctrl|arrow|to cancel|to submit|interrupt)/i;

// Strip the box a line is drawn inside, so the matchers work on the words.
// capture-pane -p emits no escapes, but the box-drawing characters are real
// text and would otherwise anchor every regex.
const strip = (line) => line.replace(LEAD_RE, '').replace(TAIL_RE, '');

/**
 * Read a pane tail and report the permission prompt sitting at the end of it.
 *
 * Returns null unless a prompt is genuinely CURRENT — a numbered choice list
 * with both a yes and a no, introduced by a question, with nothing but
 * keyboard hints after it. Every clause leans towards null: a false "blocked"
 * puts a row in front of the human with an Approve button on it, which is a
 * far worse failure than a real block noticed sixty seconds late.
 *
 * @param {string} tail plain pane text (tmux capture-pane -p)
 * @returns {{title:string, question:string, options:{n:number,label:string}[],
 *            yes:number, no:number, fingerprint:string} | null}
 */
export function detectPrompt(tail) {
  if (typeof tail !== 'string' || !tail) return null;
  if (!QUESTION_RE.test(tail)) return null; // cheap reject before the line work

  const raw = tail.split('\n');
  const lines = raw.map(strip);
  // "no content here" — a blank line or the box's own edge, both skippable.
  const border = raw.map((l) => BORDER_RE.test(l));
  // The box's horizontal RULE specifically. A blank line inside the box is
  // also contentless, but it is not a lid, and mistaking one for a lid is how
  // a line out of the middle of a diff ends up captioning the row.
  const rule = raw.map((l) => BORDER_RE.test(l) && (l.match(/[─-╿]/g) || []).length >= 3);

  // The LAST "1." in the pane — a prompt above it has been answered already.
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION_RE.exec(lines[i]);
    if (m && m[1] === '1') { first = i; break; }
  }
  if (first < 0) return null;

  // Walk forward collecting the option run. Blank and border lines inside the
  // box are fine; a content line that is not the next option ends it.
  const options = [];
  let last = first;
  for (let i = first; i < lines.length; i++) {
    if (border[i]) continue;
    const m = OPTION_RE.exec(lines[i]);
    if (!m) break;
    const n = Number(m[1]);
    if (n !== options.length + 1) break; // must run 1,2,3… — a real menu
    options.push({ n, label: m[2].replace(/\s+/g, ' ').trim() });
    last = i;
  }
  if (options.length < 2) return null;

  // A permission prompt always offers both a yes and a no. Requiring both is
  // what keeps an ordinary numbered list in Claude's own output from matching.
  const yes = options.find((o) => /^yes\b/i.test(o.label));
  const no = options.find((o) => /^no\b/i.test(o.label));
  if (!yes || !no) return null;

  // Nothing but keyboard hints may follow, or the prompt is history.
  for (let i = last + 1; i < lines.length; i++) {
    if (border[i]) continue;
    if (lines[i].length <= 80 && HINT_RE.test(lines[i])) continue;
    return null;
  }

  // The question introducing the menu, within the box above it.
  let question = '';
  let qi = -1;
  for (let i = first - 1; i >= 0 && i >= first - 20; i--) {
    if (QUESTION_RE.test(lines[i])) { question = lines[i]; qi = i; break; }
  }
  if (!question) return null;

  const { title, body } = boxAbove(lines, border, rule, qi);
  return {
    title,
    question,
    body,
    // The one line that says WHICH thing is being asked about — the command,
    // the file, the URL. It is the first body line under the heading, and it
    // is what turns "stack is asking permission" into a row worth acting on.
    detail: body.split('\n').find((l) => l && l !== title) || '',
    options,
    yes: yes.n,
    no: no.n,
    fingerprint: fingerprintOf(question, options, body),
  };
}

// The box the question sits in: its heading — "Bash command", "Edit file",
// "Fetch" — and everything between that and the question. The heading is the
// first content line under the box's TOP RULE. No rule found means no box:
// empty is honest, a line lifted out of the middle of a diff is not.
function boxAbove(lines, border, rule, qi) {
  let lid = -1;
  for (let i = qi - 1; i >= 0 && i >= qi - 40; i--) if (rule[i]) { lid = i; break; }
  if (lid < 0) return { title: '', body: '' };
  const content = [];
  for (let i = lid + 1; i < qi; i++) if (!border[i]) content.push(lines[i]);
  const title = content.length && content[0].length <= 60 ? content[0] : '';
  return { title, body: content.join('\n') };
}

// What the human actually agreed to. The Approve button carries this back to
// the host, which re-reads the pane and refuses to send a keystroke unless the
// prompt it finds is still this one — the sixty-second push interval means the
// row on screen can always be one prompt out of date, and typing "1" into a
// session that has moved on is how a stray digit lands in someone's input box.
//
// The BODY is in the hash and has to be: "Do you want to proceed?" is the
// question for every bash command there has ever been, so a question-only
// fingerprint would happily approve `rm -rf /` because the human had said yes
// to `rm -rf build` a minute earlier.
export function fingerprintOf(question, options, body = '') {
  const h = createHash('sha1');
  const SEP = '\u0000'; // a real separator, so "ab"+"c" can't hash as "a"+"bc"
  h.update(question.trim());
  for (const o of options) { h.update(SEP); h.update(o.label); }
  h.update(SEP);
  h.update(body.replace(/[ \t]+/g, ' ').trim());
  return h.digest('hex').slice(0, 16);
}
