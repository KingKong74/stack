// #519 — the finished-and-waiting read, tested against the REAL export and
// against pane text in the shape `tmux capture-pane -e -p` actually gives it
// (the fixtures below were cut from live claude v2 panes).
//
//   node server/test/input-wait.test.mjs      # exits non-zero on any failure
//
// As with prompt-scan, the NEGATIVE half is most of it: a false "waiting"
// fires a desktop notification about a busy session, and a notification that
// cries wolf is one the owner learns to ignore.
import { detectWaiting, hasDraft } from '../../terminal/input-wait.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const E = '\x1b';
const RULE = `${E}[38;5;244m${'─'.repeat(60)}${E}[39m`;
const MODE = `  ${E}[38;5;211m⏵⏵ bypass permissions on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;
const box = (input) => [RULE, input, RULE, MODE, ''].join('\n');
// claude's own suggestion, dimmed word by word exactly as v2 draws it
const SUGGESTED = `${E}[39m❯ ${E}[2mbk-os${E}[0m ${E}[2maccounting${E}[0m ${E}[2mapp${E}[0m`;
const EMPTY = `${E}[38;5;246m❯ ${E}[39m`;
const TYPED = `${E}[39m❯ lets rewire the claude.md file`;

const TURN = [
  '⏺ Here is what I found on the board.',
  '',
  // Long enough that the fingerprint's window (the last 600 characters of
  // words) sits wholly inside the turn, as it does on any real pane.
  ...Array.from({ length: 12 }, (_, i) => `  - #${500 + i}: an item the board already holds, described at a length a real turn has.`),
  '',
  '  Tell me which of these to keep and answer the two accounting questions. I\'ll then write the new',
  '  items and put the sprint in order.',
  '',
  '✻ Cooked for 1m 56s · done 3:40 pm',
  '',
].join('\n');

// ---- the stop the owner meant ---------------------------------------------

const done = detectWaiting(TURN + box(EMPTY));
check('finished turn, empty input → waiting', done && done.kind, 'input');
check('…and says what it last said, not the summary line', done && done.detail, 'items and put the sprint in order.');
check('a DIMMED suggestion is not a draft → still waiting', detectWaiting(TURN + box(SUGGESTED))?.kind, 'input');
check('the older box-drawn input reads the same',
  detectWaiting(TURN + ['╭' + '─'.repeat(40) + '╮', '│ > │', '╰' + '─'.repeat(40) + '╯', ''].join('\n'))?.kind, 'input');

// ---- everything that is NOT a stop ----------------------------------------

check('an undimmed draft — the human is typing → null', detectWaiting(TURN + box(TYPED)), null);
check('a turn still running (esc to interrupt) → null',
  detectWaiting(TURN + '✻ Frolicking… (12s · ↓ 3.1k tokens · esc to interrupt)\n\n' + box(EMPTY)), null);
check('waiting on its own background agents → null',
  detectWaiting(TURN + '✻ Waiting for 5 background agents to finish\n\n' + box(EMPTY)), null);
check('the welcome banner, no turn yet → null',
  detectWaiting(' ▐▛███▛█   Claude Code v2.1.283\n  Get to finished work sooner.\n\n' + box(SUGGESTED)), null);
check('a shell prompt drawing a bare ❯ (no rules) → null',
  detectWaiting('⏺ not really claude\n~/stack on main\n❯ \n'), null);
check('the box scrolled up with output below it → null',
  detectWaiting(TURN + box(EMPTY) + Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n')), null);
check('empty / not a string → null', [detectWaiting(''), detectWaiting(null)], [null, null]);

const PERMISSION = TURN + [
  '╭' + '─'.repeat(50) + '╮',
  '│ Bash command │',
  '│   rm -rf build │',
  '│ Do you want to proceed? │',
  '│ ❯ 1. Yes │',
  '│   2. No, and tell Claude what to do differently (esc) │',
  '╰' + '─'.repeat(50) + '╯',
].join('\n');
check('a permission prompt is prompt-scan\'s, never this → null', detectWaiting(PERMISSION), null);

// ---- a menu (AskUserQuestion) ---------------------------------------------

const MENU = [
  '⏺ I need two answers before I can plan this.',
  RULE,
  ' ☐ Currency',
  '',
  'Which currency should the ledger default to?',
  '',
  '❯ 1. AUD',
  '     Australian dollars',
  '  2. USD',
  '  3. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
].join('\n');
const menu = detectWaiting(MENU);
check('a question menu → choice', menu && menu.kind, 'choice');
check('…carrying the question', menu && menu.detail, 'Which currency should the ledger default to?');
check('a hint with no option run → null', detectWaiting('some text\nEnter to select · Esc to cancel\n'), null);

// ---- the fingerprint: one stop, one notification ---------------------------

const rewrapped = TURN.replace('I\'ll then write the new\n  items', 'I\'ll then write\n  the new items');
check('a resize rewrap is the SAME stop',
  detectWaiting(rewrapped + box(EMPTY))?.fingerprint, done?.fingerprint);
check('a scrolled-off top is the SAME stop',
  detectWaiting('older line one\nolder line two\n' + TURN + box(EMPTY))?.fingerprint, done?.fingerprint);
check('a suggestion appearing is the SAME stop',
  detectWaiting(TURN + box(SUGGESTED))?.fingerprint, done?.fingerprint);
check('a different turn is a NEW stop',
  detectWaiting(TURN.replace('sprint in order', 'backlog in order') + box(EMPTY))?.fingerprint !== done?.fingerprint, true);

// ---- hasDraft on its own ---------------------------------------------------

check('hasDraft: plain text after the glyph', hasDraft('❯ hello'), true);
check('hasDraft: dim text only', hasDraft(`❯ ${E}[2mhello${E}[0m`), false);
check('hasDraft: a 256-colour 2 is a colour, not dim', hasDraft(`❯ ${E}[38;5;2mhello`), true);
check('hasDraft: dim then reset then typed', hasDraft(`❯ ${E}[2msug${E}[22m typed`), true);
check('hasDraft: glyph alone', hasDraft('❯ '), false);

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall passing');
