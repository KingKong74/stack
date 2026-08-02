// What is an autopilot tmux session DOING right now, read from pane text.
//
// Mission Control's fleet strip shows a running autopilot job as a live row,
// and the only signal the host has for "what is it up to" is the same pane
// tail the daemon already captures for the Gemini labeller and prompt-scan
// (tmux-session.paneTail) — so this, like prompt-scan.mjs, is a PURE read
// over string text. No tmux, no spawn, no I/O: everything below is testable
// without a host at all —
//
//   node server/test/auto-scan.test.mjs
//
// Autopilot sessions run with --dangerously-skip-permissions (see
// prompt-scan.mjs's header), so they can never be blocked on a permission
// prompt — `waiting` here is NOT that check re-implemented. It is a weak,
// display-only hint that the pane's tail looks like it stopped on something
// question-shaped (a numbered menu, a trailing "?"). Nothing here decides
// whether a run needs a human; that is prompt-scan's job on stack-term-*
// sessions, and only those.

// The dispatcher names an autopilot session
// `stack-auto-${slug.replace(/[^A-Za-z0-9_]/g,'_').slice(0,30)}-j${jobId}`
// (scripts/stack-autopilot-dispatch.mjs). The sanitised run is what makes the
// SLUG this function returns NOT necessarily the project's real slug — dots,
// dashes and anything else outside [A-Za-z0-9_] became underscores, and it
// was truncated to 30 characters. Callers must match sessions on the FULL
// tmux name, never on this slug alone.
const NAME_RE = /^stack-auto-([A-Za-z0-9_-]{1,64})$/;
const JOBID_RE = /^(.*)-j(\d+)$/;

/**
 * Parse an autopilot tmux session name.
 *
 * @param {string} name tmux session name
 * @returns {{slug: string, jobId: number|null} | null} null when `name` is
 *   not an autopilot session name at all. A name with no trailing `-j<n>` is
 *   still an autopilot session (the dispatcher has always used the -j form,
 *   but nothing here should assume that stays true forever) and reports
 *   jobId: null rather than null overall — hiding it would report a running
 *   fleet as empty.
 */
export function parseAutoName(name) {
  if (typeof name !== 'string') return null;
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const rest = m[1];
  const jm = JOBID_RE.exec(rest);
  if (jm) return { slug: jm[1], jobId: Number(jm[2]) };
  return { slug: rest, jobId: null };
}

// ANSI escapes, stripped defensively. capture-pane -p is used without -e so
// tmux itself should emit none, but a stray sequence embedded in PROGRAM
// output (something the run itself printed, e.g. a coloured diff) still
// carries the real ESC byte and would otherwise reach us intact.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

// The box-drawing / bullet furniture the Claude CLI wraps its own output in.
// Stripped only from the ENDS of a line — the same rule prompt-scan.mjs uses
// for its box border, so the words in the middle of a line are never touched.
const FURNITURE = '│╭╮╰╯─✻✽✢·●⎿⏺⏵*>\\s';
const LEAD_RE = new RegExp(`^[${FURNITURE}]+`);
const TAIL_RE = new RegExp(`[${FURNITURE}]+$`);
const PROMPT_RE = /^>\s+/;

/**
 * Clean one line of pane text for reading.
 *
 * @param {string} line
 * @returns {string} the cleaned line, possibly ''
 */
export function stripNoise(line) {
  if (typeof line !== 'string') return '';
  let s = line.replace(ANSI_RE, '');
  s = s.replace(PROMPT_RE, '');
  s = s.replace(LEAD_RE, '').replace(TAIL_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// A line that is only punctuation / box art once stripped — stripNoise
// already removes the FURNITURE from the ends, so what is left here is a line
// that was furniture through and through (e.g. a bare rule or an ellipsis).
const PUNCT_ONLY_RE = /^[\s\-─═╌╍:.,·•…]*$/;

// The Claude CLI's transient status line, in whichever of its shapes it
// takes: a bare "Thinking…"/"Working…", the compound spinner-plus-timer line
// ("Marinating… (12s · ⚒ 234 tokens · esc to interrupt)"), the shortcut hint
// bar ("? for shortcuts", "⏵⏵ accept edits on"), or a lone elapsed-time
// ticker ("12s", "1m30s"). These say "still running", never WHAT is running,
// so `doing` walks straight past them.
function isTransient(line) {
  if (/\besc(?:ape)? to interrupt\b/i.test(line)) return true;
  if (/\btokens?\b/i.test(line)) return true;
  if (/\bfor shortcuts\b/i.test(line)) return true;
  if (/\baccept edits\b/i.test(line)) return true;
  if (/^\d+m?\d*s$/i.test(line)) return true; // bare elapsed ticker
  if (/^[a-z][a-z ]*…$/i.test(line)) return true; // bare "Thinking…" / "Working…"
  if (/^(thinking|working)\.{0,3}$/i.test(line)) return true;
  return false;
}

function meaningful(line) {
  if (!line) return false;
  if (PUNCT_ONLY_RE.test(line)) return false;
  if (isTransient(line)) return false;
  return true;
}

const MAX_DOING = 160;

function cap(s) {
  if (s.length <= MAX_DOING) return s;
  let cut = s.slice(0, MAX_DOING - 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 40) cut = cut.slice(0, lastSpace);
  return `${cut}…`;
}

const MENU_RE = /^(?:[❯>»]\s*)?\d{1,2}\.\s+\S/;

/**
 * Read what an autopilot pane's tail is doing right now.
 *
 * @param {string} tail plain pane text (tmux capture-pane -p), '\n' separated
 * @param {{idleMs?: number}} [opts]
 * @returns {{doing: string, lastLine: string, lines: number,
 *            waiting: boolean, idleMs: number}}
 */
export function readActivity(tail, opts) {
  const idleMs = opts && Number.isFinite(opts.idleMs) ? opts.idleMs : 0;
  const empty = { doing: '', lastLine: '', lines: 0, waiting: false, idleMs };
  if (typeof tail !== 'string' || !tail) return empty;

  const cleaned = tail.split('\n').map(stripNoise).filter((l) => l.length > 0);
  if (!cleaned.length) return empty;

  const lastLine = cleaned[cleaned.length - 1];

  // Walk from the bottom up for the first line that carries meaning, skipping
  // spinner/status furniture. Keep the FIRST transient line seen (closest to
  // the bottom) as a fallback: an empty read is worse than a vague one.
  let doing = '';
  let fallback = '';
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const line = cleaned[i];
    if (meaningful(line)) { doing = line; break; }
    if (!fallback && !PUNCT_ONLY_RE.test(line)) fallback = line;
  }
  if (!doing) doing = fallback;

  // `waiting` is a WEAK, display-only hint — NOT a re-implementation of
  // prompt-scan.mjs's rigorous permission-block detector. Autopilot sessions
  // run with --dangerously-skip-permissions, so they can never be blocked on
  // a permission prompt; this just flags "the tail looks like it stopped on
  // something question-shaped" (a numbered menu, or a trailing '?' near the
  // bottom) for anything else that halted the run.
  const recent = cleaned.filter(meaningful).slice(-6);
  const waiting = recent.some((l) => MENU_RE.test(l) || l.endsWith('?'));

  return {
    doing: cap(doing),
    lastLine,
    lines: cleaned.length,
    waiting,
    idleMs,
  };
}
