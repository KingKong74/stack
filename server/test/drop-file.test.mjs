// Where a file dragged onto a terminal pane lands (#513), tested against the
// REAL export and a real temp directory.
//
//   node server/test/drop-file.test.mjs      # exits non-zero on any failure
//
// Pure — no database, no API, no daemon. What is actually being pinned is the
// name: `name` arrives from a File object in a browser, so most of what is
// below is the hostile half — separators, dot-dots, control bytes and the
// empty string — plus the two properties the feature rests on, that a drop
// never overwrites an existing file and never escapes its directory.
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { safeName, writeDrop, prune, DROP_MAX_BYTES } from '../../terminal/drop-file.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const b64 = (s) => Buffer.from(s).toString('base64');
const dir = mkdtempSync(join(tmpdir(), 'stack-drops-'));

// ---- the name ---------------------------------------------------------------

check('an ordinary name survives whole', safeName('screenshot.png', 'image/png'), 'screenshot.png');
check('spaces become dashes', safeName('my shot 2.png'), 'my-shot-2.png');
check('only the basename survives', safeName('/home/someone/.ssh/id_rsa.pub'), 'id_rsa.pub');
check('a windows path is a basename too', safeName('C:\\Users\\me\\shot.png'), 'shot.png');
check('traversal cannot survive it', safeName('../../../etc/passwd'), 'passwd.bin');
check('dots collapse wherever they are', safeName('a..b.png'), 'a.b.png');
check('a dotfile stops being one', safeName('.bashrc'), 'bashrc.bin');
check('an empty name still names something', safeName(''), 'drop.bin');
check('a name of nothing but junk still names something', safeName('///'), 'drop.bin');
check('control bytes do not survive', safeName('sh\u0000ot\n.png'), 'sh-ot-.png');
// The invented extension is not cosmetic: claude decides what is an image by
// the extension, so a screenshot arriving as `pasted` would be read as text.
check('a nameless screenshot gets its type back', safeName('pasted', 'image/png'), 'pasted.png');
check('an unknown type falls back rather than guessing', safeName('thing', 'application/x-weird'), 'thing.bin');
check('an extension already there is never second-guessed', safeName('notes.md', 'image/png'), 'notes.md');
check('a long name is cut, not refused', safeName(`${'a'.repeat(200)}.png`).length <= 64, true);

// ---- the write --------------------------------------------------------------

const first = writeDrop({ name: 'shot.png', mime: 'image/png', data: b64('PNGBYTES'), dir });
check('a drop is written', first.ok, true);
check('...under the sanitised name', first.name, 'shot.png');
check('...into the directory it was given', dirname(first.path), dir);
check('...with the bytes it was handed', readFileSync(first.path, 'utf8'), 'PNGBYTES');

// THE ONE THAT MATTERS: two panes dropping the same filename must not become
// one file, because the path from the first is already typed into a prompt.
const second = writeDrop({ name: 'shot.png', mime: 'image/png', data: b64('OTHER'), dir });
check('a second drop of the same name never overwrites the first', second.name, 'shot-2.png');
check('...and the first is still what it was', readFileSync(first.path, 'utf8'), 'PNGBYTES');
check('the suffix goes before the extension', writeDrop({ name: 'shot.png', data: b64('c'), dir }).name, 'shot-3.png');
check('a double extension keeps its tail', writeDrop({ name: 'x.tar.gz', data: b64('a'), dir }).name, 'x.tar.gz');
check('...and suffixes before it', writeDrop({ name: 'x.tar.gz', data: b64('b'), dir }).name, 'x.tar-2.gz');

check('an empty file is refused, not written', writeDrop({ name: 'e.png', data: '', dir }).ok, false);
const big = writeDrop({ name: 'big.png', data: b64('x'.repeat(64)), dir, maxBytes: 16 });
check('over the cap is refused', big.ok, false);
check('...and says so in a sentence', /larger than/.test(big.error || ''), true);
check('the real cap is 10 MB', DROP_MAX_BYTES, 10 * 1024 * 1024);

// Traversal again, this time all the way through the write: whatever the name
// was, the file is inside the directory and nowhere else.
const escaped = writeDrop({ name: '../../escape.png', data: b64('nope'), dir });
check('a traversing name writes inside the directory', dirname(escaped.path), dir);
check('...and nothing landed above it', existsSync(join(dir, '..', 'escape.png')), false);

// ---- the prune --------------------------------------------------------------

const old = join(dir, 'ancient.png');
writeFileSync(old, 'old');
const longAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
utimesSync(old, longAgo, longAgo);
const before = readdirSync(dir).length;
const removed = prune(dir, 7 * 24 * 60 * 60 * 1000);
check('an old drop is pruned', removed, 1);
check('...and only that one', readdirSync(dir).length, before - 1);
check('a fresh drop is left alone', existsSync(first.path), true);
check('a directory that does not exist prunes nothing, quietly',
  prune(join(dir, 'nope-not-here')), 0);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
