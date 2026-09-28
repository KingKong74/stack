// Mission Control → Context's CLAUDE.md rows: the host's read and its one
// guarded write, tested against the REAL exports and a real temp directory.
//
//   node server/test/claude-md.test.mjs      # exits non-zero on any failure
//
// Pure — no database, no API, no daemon. What is pinned is what stops this
// becoming the managed library that once reverted a repo's own CLAUDE.md: a
// save built on a stale read is REFUSED, and a save can only land on an
// existing CLAUDE.md inside the named checkout.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listClaudeMd, writeClaudeMd, sha, MAX_READ_BYTES } from '../../terminal/claude-md.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const root = mkdtempSync(join(tmpdir(), 'stack-claudemd-'));
const repo = join(root, 'demo');
const put = (rel, body) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), body); };
mkdirSync(join(repo, '.git'), { recursive: true });
put('CLAUDE.md', '# root\n');
put('web/CLAUDE.md', '# web\n');
put('node_modules/pkg/CLAUDE.md', '# a dependency, not the repo\n');
put('scripts/context-budget.test.mjs', "const B = [{ path: 'CLAUDE.md', max: 15_000, what: 'x' }];\n");
put('big/CLAUDE.md', 'x'.repeat(MAX_READ_BYTES + 10));
mkdirSync(join(root, 'nogit'));
writeFileSync(join(root, 'outside.md'), 'secret');

// ---- the read ---------------------------------------------------------------

const [demo, nogit, missing] = listClaudeMd({ root, slugs: ['demo', 'nogit', 'missing'] });
check('root first, then nested, node_modules skipped', demo.files.map((f) => f.path), ['CLAUDE.md', 'big/CLAUDE.md', 'web/CLAUDE.md']);
check('a budget is read from the repo’s own budget test', demo.files[0].budget, 15000);
check('a file with no budget says null, not 0', demo.files[2].budget, null);
check('the sha covers the file on disk', demo.files[0].sha, sha(Buffer.from('# root\n')));
check('an oversized file is marked truncated', [demo.files[1].truncated, demo.files[1].body.length], [true, MAX_READ_BYTES]);
check('no .git = no checkout, not "no files"', [nogit.checkout, missing.checkout], [false, false]);
check('a slug cannot climb out of the root', listClaudeMd({ root, slugs: ['../etc'] })[0].checkout, false);

// ---- the write --------------------------------------------------------------

const rootSha = demo.files[0].sha;
const ok = writeClaudeMd({ root, slug: 'demo', path: 'CLAUDE.md', sha: rootSha, body: '# edited\n' });
check('a save on the version it opened lands', [ok.ok, readFileSync(join(repo, 'CLAUDE.md'), 'utf8')], [true, '# edited\n']);
check('and answers with the new sha', ok.sha, sha(Buffer.from('# edited\n')));
check('no temp file is left behind', readdirSync(repo).filter((f) => f.includes('.tmp')), []);

const stale = writeClaudeMd({ root, slug: 'demo', path: 'CLAUDE.md', sha: rootSha, body: '# clobber\n' });
check('A STALE SAVE IS REFUSED', [stale.ok, /changed on disk/.test(stale.error)], [false, true]);
check('and the file is untouched', readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '# edited\n');

const refuse = (name, args) => check(name, writeClaudeMd({ root, slug: 'demo', sha: rootSha, body: 'x', ...args }).ok, false);
refuse('only a file named CLAUDE.md', { path: 'README.md' });
refuse('no dot-dot', { path: '../outside/CLAUDE.md' });
refuse('no absolute path', { path: '/etc/CLAUDE.md' });
refuse('never creates a file', { path: 'new/CLAUDE.md', sha: sha(Buffer.from('')) });
refuse('a slug must be clean', { slug: '../demo', path: 'CLAUDE.md' });
refuse('a sha is required', { path: 'CLAUDE.md', sha: '' });
check('the refused create left nothing behind', existsSync(join(repo, 'new')), false);

symlinkSync(join(root, 'outside.md'), join(repo, 'web', 'link'));
mkdirSync(join(repo, 'sym'));
symlinkSync(join(root, 'outside.md'), join(repo, 'sym', 'CLAUDE.md'));
refuse('never writes through a symlink', { path: 'sym/CLAUDE.md', sha: sha(Buffer.from('secret')) });
check('the symlink target is untouched', readFileSync(join(root, 'outside.md'), 'utf8'), 'secret');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
