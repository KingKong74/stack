// Has this claude session FINISHED ITS TURN and gone quiet at its own input?
//
// #519 — the half of "a session stopped for you" that prompt-scan.mjs cannot
// see. prompt-scan reads a PERMISSION prompt, and the owner runs every
// session with permissions bypassed ("⏵⏵ bypass permissions on"), so that
// scan has never once fired for him: a claude session that stops to ask him
// something does it in PROSE ("Tell me which of these to keep…") and then
// sits at an empty ❯ — or on an AskUserQuestion menu — for as long as nobody
// looks. That is the stop the owner meant, and it was invisible end to end.
//
// Pure, like prompt-scan.mjs, and for the same reason: everything below is
// string work over a pane capture, testable with no tmux, claude or host —
//
//   node server/test/input-wait.test.mjs
//
// IT READS A STYLED CAPTURE (tmux capture-pane -e), not the plain one the
// other scans take, and that is load-bearing rather than incidental. Claude
// Code pre-fills its input with a SUGGESTED next prompt, drawn DIM (SGR 2);
// in a plain capture it is indistinguishable from text the human has typed.
// Reading a suggestion as a draft would say "the human is already answering"
// of every finished session that has one — which is most of them — and the
// feature would be dead on arrival a second time. So: dim text after the ❯ is
// a suggestion and the input is empty; anything undimmed is a real draft.
//
// IT LEANS TOWARDS NULL, prompt-scan's rule, for prompt-scan's reason: a
// false "waiting" fires a desktop notification about a session that is busy,
// which teaches the owner to ignore the notification — far worse than one
// that arrives a tick late. Every clause below only ever REFUSES:
//
//   · a permission prompt is prompt-scan's, never this (no double report);
//   · anything saying "to interrupt" is a turn still running;
//   · "waiting for N background agents/tasks to finish" is claude waiting on
//     ITSELF, not on the human;
//   · the ❯ must sit between two rules — claude's input box — or it is a
//     shell prompt (starship, pure and friends draw a bare ❯ too);
//   · an undimmed draft means the human is already at the keyboard;
//   · no assistant turn above the box (the welcome banner) is not a stop.
//
// And one guard the daemon adds, because a single read cannot: a candidate is
// only REPORTED once two reads twenty seconds apart agree on its fingerprint
// (`watchBlocks` in stack-term.mjs). A turn between tool calls can look idle
// for an instant; it does not look identical twenty seconds later.

import { createHash } from 'node:crypto';
import { detectPrompt } from './prompt-scan.mjs';

// SGR and every other CSI sequence. -e emits SGR only, but program output can
// carry anything.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const BOX = '\\u2500-\\u257f\\u2588\\u258c\\u2590';
const LEAD_RE = new RegExp(`^[\\s${BOX}]+`);
const TAIL_RE = new RegExp(`[\\s${BOX}]+$`);
const RULE_RE = new RegExp(`^[\\s${BOX}]*$`);

// The input glyph, alone once the box and whitespace (NBSP included — claude
// writes "❯ ") are stripped. `>` is the older box-drawn input.
const INPUT_RE = /^[❯>]$/;
// The same, at the START of a line that still carries its text.
const INPUT_LEAD_RE = /^[\s│]*[❯>][\s ]?/;

// Still running: the spinner line says how to stop it.
const WORKING_RE = /\b(?:esc(?:ape)?|ctrl\+c) to interrupt\b/i;
// Waiting on its own subagents or background shells.
const SELF_WAIT_RE = /\bbackground (?:agents?|tasks?|shells?|jobs?)\b.*\bto finish\b/i;
// A menu's footer — AskUserQuestion and friends.
const MENU_HINT_RE = /\benter to (?:select|confirm|submit|choose)\b/i;
const OPTION_RE = /^(?:[❯>»]\s*)?(\d{1,2})\.\s+(\S.*)$/;
// An assistant turn: the bullet claude prints its messages under ("⏺" on most
// fonts, "●" where that glyph is missing), or the turn's closing summary line
// ("✻ Cooked for 1m 56s").
const TURN_RE = /^(?:[⏺●]\s|[✻✢✳✶✽*·]\s+\S+ for \d)/;
const SUMMARY_RE = /^[✻✢✳✶✽*·]\s+\S+ for \d/;

const plain = (l) => l.replace(OSC_RE, '').replace(CSI_RE, '');
const strip = (l) => plain(l).replace(LEAD_RE, '').replace(TAIL_RE, '');
const isRule = (l) => { const p = plain(l); return RULE_RE.test(p) && (p.match(/[─-╿]/g) || []).length >= 3; };

/**
 * Is there UNDIMMED text after the input glyph on this styled line? That is a
 * draft the human typed; dim text is claude's own suggestion.
 * @param {string} styled one line of `capture-pane -e` output
 */
export function hasDraft(styled) {
  if (typeof styled !== 'string') return false;
  // Walk the line, tracking SGR 2 (dim) on and off.
  let dim = false;
  let seenGlyph = false;
  let i = 0;
  while (i < styled.length) {
    if (styled[i] === '\x1b' && styled[i + 1] === '[') {
      const m = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(styled.slice(i)); // eslint-disable-line no-control-regex
      if (!m) { i++; continue; }
      if (m[3] === 'm') {
        const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n) || 0);
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k];
          // 38/48 carry a colour argument — skip it so "38;5;2" is not read as dim.
          if (c === 38 || c === 48 || c === 58) { k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 0; continue; }
          if (c === 0 || c === 22) dim = false;
          else if (c === 2) dim = true;
        }
      }
      i += m[0].length;
      continue;
    }
    const ch = styled[i];
    if (!seenGlyph) {
      if (ch === '❯' || ch === '>') seenGlyph = true;
    } else if (!/[\s │]/.test(ch) && !dim) {
      return true;
    }
    i++;
  }
  return false;
}

// What the fingerprint is taken over: the words of the turn, with every space
// and line break removed, and only the last stretch of it. A pane RESIZE
// rewraps the text and slides the top of the capture window; neither is a new
// stop, and a fingerprint that moved with them would notify twice for one.
function fingerprint(kind, lines) {
  const words = lines.map(plain).join('').replace(/[\s ]+/g, '').slice(-600);
  return createHash('sha1').update(`${kind}\u0000${words}`).digest('hex').slice(0, 16);
}

const cap = (s, n = 200) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * @param {string} styledTail `tmux capture-pane -e -p` output
 * @returns {{kind:'input'|'choice', detail:string, fingerprint:string} | null}
 */
export function detectWaiting(styledTail) {
  if (typeof styledTail !== 'string' || !styledTail) return null;
  const raw = styledTail.replace(/\s+$/, '').split('\n');
  const text = raw.map(plain);
  const joined = text.join('\n');

  // A permission prompt is the other scan's, with its Approve button.
  if (detectPrompt(joined)) return null;
  if (WORKING_RE.test(joined)) return null;
  if (SELF_WAIT_RE.test(joined)) return null;

  const lines = raw.map(strip);

  // ---- a menu (AskUserQuestion) --------------------------------------------
  // Its footer hint within the last few content lines, a 1,2,… option run
  // above it, and the question the options answer.
  const content = [];
  for (let i = lines.length - 1; i >= 0 && content.length < 3; i--) if (lines[i]) content.push(i);
  const hint = content.find((i) => MENU_HINT_RE.test(lines[i]));
  if (hint !== undefined) {
    let first = -1;
    for (let i = hint - 1; i >= 0 && i >= hint - 40; i--) {
      const m = OPTION_RE.exec(lines[i]);
      if (m && m[1] === '1') { first = i; break; }
    }
    if (first < 0) return null;
    let n = 0;
    for (let i = first; i < hint; i++) {
      const m = OPTION_RE.exec(lines[i]);
      if (m && Number(m[1]) === n + 1) n++;
    }
    if (n < 2) return null;
    let question = '';
    for (let i = first - 1; i >= 0 && i >= first - 12; i--) {
      if (lines[i].endsWith('?')) { question = lines[i]; break; }
    }
    return { kind: 'choice', detail: cap(question), fingerprint: fingerprint('choice', raw.slice(Math.max(0, first - 12), hint)) };
  }

  // ---- an empty input box after a finished turn ----------------------------
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (INPUT_LEAD_RE.test(text[i]) && (INPUT_RE.test(lines[i]) || hasDraftCandidate(lines[i]))) { p = i; break; }
  }
  if (p < 1 || p + 1 >= raw.length) return null;
  if (!isRule(raw[p - 1]) || !isRule(raw[p + 1])) return null;
  // Below the box: the mode line and, at most, a short agents list. More than
  // that and this is not claude's input box at the foot of the screen.
  if (lines.slice(p + 2).filter(Boolean).length > 10) return null;
  if (hasDraft(raw[p])) return null;

  const above = lines.slice(0, p - 1);
  if (!above.some((l) => TURN_RE.test(l))) return null;

  // What it last said: the last content line above the box that is not the
  // turn's summary ("✻ Cooked for 1m 56s").
  let detail = '';
  for (let i = above.length - 1; i >= 0; i--) {
    const l = above[i];
    if (!l || SUMMARY_RE.test(l)) continue;
    detail = l.replace(/^[⏺●⎿]\s*/, '');
    break;
  }
  return { kind: 'input', detail: cap(detail), fingerprint: fingerprint('input', raw.slice(0, p - 1)) };
}

// The input line with text after the glyph — only a candidate; hasDraft
// decides whether that text is the human's or claude's dimmed suggestion.
function hasDraftCandidate(stripped) {
  return /^[❯>][\s ]+\S/.test(stripped);
}
