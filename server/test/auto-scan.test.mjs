// The autopilot pane read, tested against the REAL export and against pane
// text in the shape the Claude CLI actually prints.
//
//   node server/test/auto-scan.test.mjs      # exits non-zero on any failure
//
// Both directions matter here too, though the stakes differ from
// prompt-scan's. A missed real line just leaves `doing` reporting an older
// (still real) line, which the spec explicitly prefers over guessing — so
// most of what is below pins the SKIP behaviour (spinners, timers, hint
// bars) and the FALLBACK behaviour (an all-spinner tail still returns
// something rather than '').
import { parseAutoName, stripNoise, readActivity } from '../../terminal/auto-scan.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- parseAutoName ----------------------------------------------------------

check('the real dispatcher shape', parseAutoName('stack-auto-stack-j412'), { slug: 'stack', jobId: 412 });
check('a slug that already contained underscores (sanitised, not the project slug)',
  parseAutoName('stack-auto-my_project-j7'), { slug: 'my_project', jobId: 7 });
check('no -j form is still an autopilot session', parseAutoName('stack-auto-myproject'), { slug: 'myproject', jobId: null });

check('a terminal session is not an autopilot session', parseAutoName('stack-term-abc'), null);
check('stack-auto- with nothing after it', parseAutoName('stack-auto-'), null);
check('a slash in the name', parseAutoName('stack-auto-foo/bar-j1'), null);
check('a semicolon in the name', parseAutoName('stack-auto-foo;bar-j1'), null);
check('a 200-character name', parseAutoName(`stack-auto-${'a'.repeat(200)}`), null);
check('not a string (number)', parseAutoName(412), null);
check('not a string (null)', parseAutoName(null), null);
check('not a string (undefined)', parseAutoName(undefined), null);

// ---- stripNoise -------------------------------------------------------------

check('a box-drawn line loses its border, keeps its words',
  stripNoise('│ Bash command                                                 │'), 'Bash command');
check('an ANSI-wrapped line loses the escapes, keeps the text',
  stripNoise('\x1b[32mBuild succeeded\x1b[0m'), 'Build succeeded');
check('a bullet line loses its marker',
  stripNoise('● I\'ll wire up the new roadmap endpoint.'), 'I\'ll wire up the new roadmap endpoint.');
check('runs of whitespace collapse to one space',
  stripNoise('  Bash(npm   run    build)   '), 'Bash(npm run build)');
check('non-string input is the empty string', stripNoise(null), '');
check('non-string input is the empty string (number)', stripNoise(42), '');

// ---- readActivity -------------------------------------------------------------

// A realistic multi-line Claude CLI pane tail: an assistant bullet, an edit,
// a tool-call line, its result, and a spinner sitting at the very bottom.
const REALISTIC_TAIL = `
● I'll wire up the new roadmap endpoint.

⏺ Update(server/src/routes/roadmap.js)
  ⎿ Updated server/src/routes/roadmap.js with 12 additions

⏺ Bash(npm run build)
  ⎿ Running…

✻ Marinating… (14s · ⚒ 892 tokens · esc to interrupt)
`;

{
  const a = readActivity(REALISTIC_TAIL);
  check('realistic tail: doing skips the spinner and the "Running…" status, returns the real tool call',
    a.doing, 'Bash(npm run build)');
  check('realistic tail: lastLine is the literal bottom line, spinner included',
    a.lastLine, 'Marinating… (14s · ⚒ 892 tokens · esc to interrupt)');
  check('realistic tail: lines counts every non-empty cleaned line', a.lines, 6);
  check('realistic tail: nothing question-shaped, not waiting', a.waiting, false);
  check('realistic tail: idleMs defaults to 0', a.idleMs, 0);
}

// A tail that is ONLY spinner/status lines: the fallback must still return
// something readable rather than ''.
{
  const a = readActivity('\n✻ Thinking… (2s · esc to interrupt)\n');
  check('spinner-only tail: falls back to the spinner line, not empty',
    a.doing, 'Thinking… (2s · esc to interrupt)');
}

// Empty / unreadable tails.
check('empty string tail', readActivity(''), { doing: '', lastLine: '', lines: 0, waiting: false, idleMs: 0 });
check('whitespace-only tail', readActivity('   \n   \n'), { doing: '', lastLine: '', lines: 0, waiting: false, idleMs: 0 });
check('null tail', readActivity(null), { doing: '', lastLine: '', lines: 0, waiting: false, idleMs: 0 });
check('undefined tail', readActivity(undefined), { doing: '', lastLine: '', lines: 0, waiting: false, idleMs: 0 });

// A tail whose last meaningful line is a question.
{
  const a = readActivity(`
● I've finished the migration script.

Should I run it against the staging database now?
`);
  check('a trailing question sets waiting', a.waiting, true);
  check('the question is also what doing reports', a.doing, 'Should I run it against the staging database now?');
}

// A very long line: the 160-char cap, cut on a word boundary.
{
  const words = [];
  let len = 0;
  while (len < 220) { words.push('lorem'); len += 6; }
  const long = words.join(' ');
  const a = readActivity(long);
  check('a very long line is capped at 160 characters', a.doing.length <= 160, true);
  check('the cap ends with a single ellipsis', a.doing.endsWith('…'), true);
  check('the cap did not split a word', /^lorem( lorem)*…$/.test(a.doing), true);
}

// idleMs passes through opts untouched.
check('idleMs passes through from opts', readActivity('● doing a thing', { idleMs: 4500 }).idleMs, 4500);
check('idleMs defaults to 0 when opts is absent', readActivity('● doing a thing').idleMs, 0);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
