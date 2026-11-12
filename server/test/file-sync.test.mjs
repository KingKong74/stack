// The host's half of the file exchange (terminal/file-sync.mjs), tested
// against the REAL export, a real temp directory and a fake server.
//
//   node server/test/file-sync.test.mjs      # exits non-zero on any failure
//
// Pure: no database, no API, no daemon. Pinned here: an inbox mirrors the
// shared list, a bad name off the wire never becomes a path, an unreachable
// server deletes nothing, only planted files are removed, and an outbox file
// is sent once per version and never while it is still being written.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncFiles, isSafeHostName, isSafeSlug } from '../../terminal/file-sync.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

function fakeServer(state) {
  const puts = [];
  const api = async (path, init = {}) => {
    if (state.down) throw new Error('ECONNREFUSED');
    if (path === '/api/files/sync') return new Response(JSON.stringify({ projects: state.projects, inbox: state.inbox }));
    const f = path.match(/^\/api\/projects\/([^/]+)\/artifacts\/(\d+)\/file$/);
    if (f) return new Response(state.bytes[f[2]] ?? 'x');
    const o = path.match(/^\/api\/files\/([^/]+)\/out\/(.+)$/);
    if (o && init.method === 'PUT') { puts.push(`${o[1]}/${decodeURIComponent(o[2])}`); return new Response('{}', { status: 201 }); }
    return new Response('{}', { status: 404 });
  };
  return { api, puts };
}

const dir = mkdtempSync(join(tmpdir(), 'file-sync-'));
const state = {
  projects: ['alpha', '../evil'],
  inbox: [
    { slug: 'alpha', id: 7, hostName: '7-brief.md', size: 5, updatedAt: 't1' },
    { slug: 'alpha', id: 8, hostName: '8-../../x', size: 5, updatedAt: 't1' },
    { slug: '../evil', id: 9, hostName: '9-a.txt', size: 5, updatedAt: 't1' },
  ],
  bytes: { 7: 'hello' },
};
const srv = fakeServer(state);

check('names: id-prefixed plain name is safe', isSafeHostName('7-brief.md'), true);
check('names: traversal is not', isSafeHostName('8-../../x'), false);
check('slugs: ../evil is not a slug', isSafeSlug('../evil'), false);

let r = await syncFiles({ api: srv.api, dir });
check('inbox: the shared file lands', readFileSync(join(dir, 'alpha', 'inbox', '7-brief.md'), 'utf8'), 'hello');
check('inbox: only the safe entry is fetched', r.downloaded, 1);
check('folders: outbox made for the project', existsSync(join(dir, 'alpha', 'outbox')), true);
check('folders: no folder for a bad slug', existsSync(join(dir, '..', 'evil')), false);

r = await syncFiles({ api: srv.api, dir });
check('inbox: an unchanged file is not fetched again', r.downloaded, 0);

// Somebody else's file in an inbox, then the server goes down.
writeFileSync(join(dir, 'alpha', 'inbox', 'mine.txt'), 'keep');
state.down = true; state.inbox = [];
r = await syncFiles({ api: srv.api, dir });
check('fail safe: unreachable server removes nothing', existsSync(join(dir, 'alpha', 'inbox', '7-brief.md')), true);
state.down = false;
r = await syncFiles({ api: srv.api, dir });
check('unshare: the planted file goes', existsSync(join(dir, 'alpha', 'inbox', '7-brief.md')), false);
check('unshare: a file it did not plant stays', existsSync(join(dir, 'alpha', 'inbox', 'mine.txt')), true);

// Outbox: a fresh file waits, a settled one is sent once, a change re-sends.
const out = join(dir, 'alpha', 'outbox', 'report.md');
writeFileSync(out, 'v1');
r = await syncFiles({ api: srv.api, dir });
check('outbox: a file still being written waits', r.uploaded, 0);
const old = (Date.now() - 10_000) / 1000;
utimesSync(out, old, old);
r = await syncFiles({ api: srv.api, dir });
check('outbox: a settled file is sent', srv.puts, ['alpha/report.md']);
r = await syncFiles({ api: srv.api, dir });
check('outbox: the same bytes are not sent twice', r.uploaded, 0);
writeFileSync(out, 'v2'); utimesSync(out, old, old);
r = await syncFiles({ api: srv.api, dir });
check('outbox: changed bytes are sent again', r.uploaded, 1);
writeFileSync(join(dir, 'alpha', 'outbox', 'my notes!.md'), 'x'); utimesSync(join(dir, 'alpha', 'outbox', 'my notes!.md'), old, old);
r = await syncFiles({ api: srv.api, dir });
check('outbox: an unsendable name is reported, not sent', [r.uploaded, r.notes.length], [0, 1]);
r = await syncFiles({ api: srv.api, dir });
check('outbox: and reported once', r.notes.length, 0);
check('outbox: nothing in it was deleted', readdirSync(join(dir, 'alpha', 'outbox')).sort(), ['my notes!.md', 'report.md']);

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall passing');
