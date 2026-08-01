// The blocked-on-a-prompt read, tested against the REAL export and against
// pane text in the shape tmux actually captures it.
//
//   node server/test/prompt-scan.test.mjs      # exits non-zero on any failure
//
// Both directions matter and they are not symmetric. A missed prompt costs a
// row that shows up on the next 60s push. A FALSE prompt puts an Approve
// button in front of the human for a question nobody asked — so most of what
// is below is the negative half: menus that are not permission prompts,
// prompts that have already been answered, prompts that scrolled away.
import { detectPrompt, fingerprintOf } from '../../terminal/prompt-scan.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- the real shapes -------------------------------------------------------

const BASH = `
● I'll remove the stale build directory first.

╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                 │
│                                                              │
│   rm -rf build                                               │
│   Remove the stale build output                              │
│                                                              │
│ Do you want to proceed?                                      │
│ ❯ 1. Yes                                                     │
│   2. Yes, and don't ask again for rm commands in ~/stack     │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
`;

const EDIT = `
╭──────────────────────────────────────────────────────────────╮
│ Edit file                                                    │
│                                                              │
│ server/src/routes/control.js                                 │
│    376    control.get('/', async (req, res) => {             │
│    377 -    const rows = await q(SQL);                       │
│    377 +    const rows = await q(SQL2);                      │
│                                                              │
│ Do you want to make this edit to control.js?                 │
│   1. Yes                                                     │
│ ❯ 2. Yes, allow all edits during this session (shift+tab)    │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
  Press esc to cancel
`;

const TRUST = `
╭────────────────────────────────────────────╮
│ Do you trust the files in this folder?     │
│                                            │
│ /home/bailey/reliquary                     │
│                                            │
│ 1. Yes, proceed                            │
│ 2. No, exit                                │
╰────────────────────────────────────────────╯
`;

{
  const p = detectPrompt(BASH);
  check('bash: fires', p !== null, true);
  check('bash: question', p.question, 'Do you want to proceed?');
  check('bash: heading is the box title, not the command', p.title, 'Bash command');
  check('bash: three options', p.options.length, 3);
  check('bash: yes is the plain yes, not the sticky one', p.yes, 1);
  check('bash: no', p.no, 3);
}
{
  const p = detectPrompt(EDIT);
  check('edit: fires with the cursor parked on option 2', p !== null, true);
  check('edit: question', p.question, 'Do you want to make this edit to control.js?');
  check('edit: heading', p.title, 'Edit file');
  check('edit: yes is 1 even though ❯ sits on 2', p.yes, 1);
  check('edit: a trailing key hint does not disqualify it', p.options.length, 3);
}
{
  const p = detectPrompt(TRUST);
  check('trust: fires', p !== null, true);
  check('trust: yes/no', [p.yes, p.no], [1, 2]);
  // The question IS the first line of the box, so there is no separate
  // heading above it — and reporting none beats inventing one.
  check('trust: no heading to find', p.title, '');
}

// ---- the negative half -----------------------------------------------------

check('empty pane', detectPrompt(''), null);
check('not a string', detectPrompt(null), null);

check('plain output with no menu', detectPrompt(`
● Do you want to proceed with the migration? I'd suggest running it
  against a copy first.
`), null);

check('a numbered list in Claude\'s own output', detectPrompt(`
● Here is what I would do:
  1. Read the schema
  2. Write the migration
  3. Run the tests
`), null);

check('a menu with no question above it', detectPrompt(`
  1. Yes
  2. No, and tell Claude what to do differently
`), null);

check('a question with a menu that has no no', detectPrompt(`
│ Do you want to proceed?           │
│ 1. Yes                            │
│ 2. Yes, and don't ask again       │
`), null);

check('a question whose menu skips a number', detectPrompt(`
│ Do you want to proceed?           │
│ 1. Yes                            │
│ 3. No, cancel                     │
`), null);

check('answered — the session moved on below the box', detectPrompt(`${BASH}
● Removed. Now rebuilding.

⏺ Bash(npm run build)
  ⎿ vite v5.4.0 building for production...
`), null);

{
  // Two prompts in the scrollback: the LAST one is the live one.
  const p = detectPrompt(`${BASH}\n● Done.\n${TRUST}`);
  check('two prompts: reads the last', p.question, 'Do you trust the files in this folder?');
}

// ---- the fingerprint -------------------------------------------------------

{
  const a = detectPrompt(BASH);
  const b = detectPrompt(BASH.replace('❯ 1. Yes', '  1. Yes').replace('  3. No', '❯ 3. No'));
  check('the cursor moving is not a different prompt', a.fingerprint, b.fingerprint);

  // The one that matters: "Do you want to proceed?" is the question for every
  // bash command ever, so the body has to be in the hash or an Approve aimed
  // at `rm -rf build` would land on whatever replaced it.
  const c = detectPrompt(BASH.replace('rm -rf build', 'rm -rf /'));
  check('same question, different command — a DIFFERENT prompt',
    c.fingerprint === a.fingerprint, false);

  const d = detectPrompt(EDIT);
  check('a different question is a different prompt', d.fingerprint === a.fingerprint, false);
  check('fingerprint is short and hex', /^[0-9a-f]{16}$/.test(a.fingerprint), true);
  check('fingerprintOf is the same function the detector used',
    fingerprintOf(a.question, a.options, a.body), a.fingerprint);
  check('the command is the row detail', a.detail, 'rm -rf build');
  check('the file is the row detail on an edit', d.detail, 'server/src/routes/control.js');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
