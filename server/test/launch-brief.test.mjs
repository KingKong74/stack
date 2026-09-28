// The first prompt a board card hands a new claude session (#525), tested
// against the REAL export, a real temp directory and REAL shells.
//
//   node server/test/launch-brief.test.mjs      # exits non-zero on any failure
//
// Pure — no database, no API, no daemon, no tmux. The property being pinned is
// the one the feature rests on: a brief is a card title somebody typed, and it
// must reach claude as ONE argument, byte for byte, through the same two
// shells the daemon's spawn string goes through (tmux's `sh -c`, then
// `/bin/bash -lc "…"`), with nothing in it ever run. `printf` stands in for
// claude, so what it prints is exactly what claude would have been handed.
import { mkdtempSync, existsSync, statSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { briefPath, writeBrief, briefArg, pruneBriefs, BRIEF_MAX_CHARS } from '../../terminal/launch-brief.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const dir = mkdtempSync(join(tmpdir(), 'stack-briefs-'));

// ---- the path ---------------------------------------------------------------

check('a daemon session name makes a path', briefPath('stack-term-a1b2c3d4', dir), join(dir, 'stack-term-a1b2c3d4.md'));
check('a name outside validName makes none', briefPath('../etc/passwd', dir), null);
check('a quote in the name makes none', briefPath("stack-x'y", dir), null);
check('an empty name makes none', briefPath('', dir), null);
check('a quote in the DIRECTORY makes none', briefPath('stack-term-1', join(dir, "it's")), null);

// ---- the write --------------------------------------------------------------

check('an empty brief writes nothing', writeBrief('stack-term-empty', '   ', dir), null);
const p = writeBrief('stack-term-cap', 'x'.repeat(BRIEF_MAX_CHARS + 50), dir);
check('the brief is capped', statSync(p).size, BRIEF_MAX_CHARS);
check('the brief is 0600', (statSync(p).mode & 0o777).toString(8), '600');

// ---- through both shells -----------------------------------------------------
//
// The spawn string exactly as stack-term.mjs builds it, with `printf` where
// `claude` is, run the way tmux runs a new session's command.
const hostile = [
  'Work #525: "quoted" and \'single\' and `touch PWNED-backtick`',
  '$(touch PWNED-subst) ${HOME} $HOME \\ backslash; touch PWNED-semi',
  '',
  '  indented line, then a trailing space ',
].join('\n');
const f = writeBrief('stack-term-hostile', hostile, dir);
const shellCmd = `/bin/bash -lc "exec printf %s${briefArg(f)}"`;
const run = spawnSync('sh', ['-c', shellCmd], { cwd: dir, encoding: 'utf8' });
check('the brief arrives as one argument, byte for byte', run.stdout, hostile.trim());
check('nothing in the brief ran', readdirSync(dir).filter((n) => n.startsWith('PWNED')), []);
check('reading the brief deletes it', existsSync(f), false);

// The gateway spelling: the brief follows `--`, after the permissions flag.
const g = writeBrief('stack-term-gw', 'hello gateway', dir);
const gw = spawnSync('sh', ['-c', `/bin/bash -lc "exec printf '[%s]' -- --dangerously-skip-permissions${briefArg(g)}"`], { encoding: 'utf8' });
check('after the flags it is still one argument', gw.stdout, '[--][--dangerously-skip-permissions][hello gateway]');

// ---- pruning ----------------------------------------------------------------

const old = writeBrief('stack-term-old', 'stale', dir);
const fresh = writeBrief('stack-term-fresh', 'new', dir);
const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
utimesSync(old, past, past);
writeFileSync(join(dir, 'unrelated-but-fresh.txt'), 'x');
check('only a stale brief is pruned', pruneBriefs({ dir }), 1);
check('the fresh one survives', [existsSync(old), existsSync(fresh)], [false, true]);
check('a missing directory prunes nothing', pruneBriefs({ dir: join(dir, 'nope') }), 0);

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
