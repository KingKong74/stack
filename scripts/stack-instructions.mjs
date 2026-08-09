#!/usr/bin/env node
// Stack — the INSTRUCTIONS TREE's host half.
//
// The server holds the library; this makes the host's disk match it and reports
// back what is really there. Run from the dispatcher's tick (every ~5 minutes,
// stamped) or by hand: `node scripts/stack-instructions.mjs [--dry]`.
//
// Files live where Claude Code reads them — `~/.claude/CLAUDE.md` for the
// personal one, `<repo>/CLAUDE.md` and `<repo>/<dir>/CLAUDE.md` for a project's.
// Nothing here invents a Stack-specific location, because the point of the
// feature is editing the files that are already being read.
//
// THE RULE THIS RESTS ON: **Stack only ever writes or removes a CLAUDE.md it
// planted.** The marker is a line inside the file itself —
//
//     <!-- stack-managed -->
//
// — rather than a sidecar, because a CLAUDE.md is one file and not a directory,
// and because a marker that travels with the file survives a `git mv` that a
// sidecar would not. It is an HTML comment, so markdown swallows it and the
// model reading the file gets the rules without the bookkeeping. A file WITHOUT
// that line is reported and never touched: not written over, not deleted, not
// disabled. Adopting one is a press in the app, which writes the marker on the
// next tick — that is what consent looks like for a file somebody hand-wrote.
//
// Fails SAFE in the #287 sense rather than the arm-switch sense: an unreachable
// API, a missing token or a malformed payload does NOTHING. This deletes files.
//
// The scan is bounded on every axis a filesystem walk has to be bounded on —
// which repos (only the slugs the server names), how deep, which directories
// (never node_modules, .git, build output or a worktree root), and how many
// files. An unbounded walk of $HOME on a five-minute cron is not a thing to
// ship, and a scan that quietly truncates is worse than one that says it did:
// `detail` carries the cut.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';

loadStackEnv();
const API = (process.env.STACK_API || '').replace(/\/+$/, '');
const TOKEN = process.env.STACK_TOKEN || '';
// Same convention as the dispatcher and the skills sync: repos live at
// $STACK_AUTOPILOT_ROOT/<slug>.
const REPO_ROOT = process.env.STACK_AUTOPILOT_ROOT || homedir();

const MARKER = '<!-- stack-managed -->';
const FILENAME = 'CLAUDE.md';
const BODY_CAP = 40_000;
const MAX_DEPTH = 4;          // <repo>/a/b/c/CLAUDE.md and no deeper
const MAX_PER_REPO = 24;      // a repo with more CLAUDE.md files than this has a generator loose
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache',
  // Stack's own scratch trees. A worktree is a second checkout of a repo we
  // already scan, so walking it reports every file twice under a path the
  // server cannot place — and one of the two copies would then look unmanaged.
  'worktrees', '.worktrees',
]);

const log = (msg) => logStderr(`instructions ${new Date().toISOString()} · ${msg}`);

const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
};

// Where a repo is on this host, or '' when it was never cloned here. A project
// file for a repo that does not exist has nowhere to go, and creating the
// directory would scatter CLAUDE.md files around the filesystem.
const repoFor = (slug) => {
  if (!slug || !/^[a-z0-9._-]+$/i.test(slug)) return '';
  const repo = join(REPO_ROOT, slug);
  return existsSync(join(repo, '.git')) ? repo : '';
};

// The absolute path of one place in the tree, or '' when there isn't one.
const fileFor = (scope, slug, dir) => {
  if (scope === 'global') return join(homedir(), '.claude', FILENAME);
  const repo = repoFor(slug);
  if (!repo) return '';
  // The server already cleaned `dir` (no traversal, no absolute paths), but
  // this is the step that turns it into a filesystem write, so it is checked
  // again here rather than trusted across the wire.
  const safe = String(dir || '').split('/').filter((s) => s && s !== '.' && s !== '..'
    && /^[A-Za-z0-9._@-]{1,64}$/.test(s)).slice(0, MAX_DEPTH);
  if (String(dir || '') && safe.join('/') !== String(dir)) return '';
  return join(repo, ...safe, FILENAME);
};

const isManaged = (text) => String(text || '').includes(MARKER);
// What the app edits: the file without Stack's bookkeeping line. Stripping it
// on the way IN is what keeps the marker out of the raw editor, so nobody can
// delete it by accident and orphan their own file.
const stripMarker = (text) => String(text || '')
  .split('\n').filter((l) => l.trim() !== MARKER).join('\n').replace(/\s+$/, '');

// How many tracked files this directory reaches — the map's "reaches N files",
// counted by git rather than guessed. -1 when it could not be counted (not a
// repo, git absent, a timeout): the server renders that as unknown and never as
// zero, the same rule as a NULL review verdict.
function reachOf(repo, dir) {
  if (!repo) return -1;
  try {
    const out = execFileSync('git', ['-C', repo, 'ls-files', '--', dir || '.'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return out.split('\n').filter(Boolean).length;
  } catch { return -1; }
}

// Every CLAUDE.md under one repo, managed or not. Bounded by MAX_DEPTH,
// MAX_PER_REPO and the SKIP set; returns `{ files, truncated }` so the caller
// can say out loud that it stopped early.
function scanRepo(repo, slug) {
  const files = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_PER_REPO) { truncated = true; return; }
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path, depth + 1);
      } else if (e.isFile() && e.name === FILENAME) {
        let text = '';
        let bytes = 0;
        try { text = readFileSync(path, 'utf8'); bytes = statSync(path).size; } catch { continue; }
        const rel = relative(repo, dirname(path)).split(sep).filter(Boolean).join('/');
        files.push({
          scope: 'project', slug, dir: rel, path,
          managed: isManaged(text),
          body: stripMarker(text).slice(0, BODY_CAP),
          reach: reachOf(repo, rel),
          bytes,
        });
      }
    }
  };
  walk(repo, 0);
  return { files, truncated };
}

function scanGlobal() {
  const path = join(homedir(), '.claude', FILENAME);
  if (!existsSync(path)) return [];
  let text = '';
  let bytes = 0;
  try { text = readFileSync(path, 'utf8'); bytes = statSync(path).size; } catch { return []; }
  return [{
    scope: 'global', slug: '', dir: '', path,
    managed: isManaged(text),
    body: stripMarker(text).slice(0, BODY_CAP),
    // The personal file reaches every repo you open, which is not a number.
    reach: -1,
    bytes,
  }];
}

export async function syncInstructions({ dry = false } = {}) {
  if (!API || !TOKEN) { log('no API/token in ~/.stack/env — nothing done'); return null; }

  let work;
  try { work = await api('GET', '/api/instructions/work'); }
  catch (e) { log(`could not read the library (${e.message}) — nothing done`); return null; }
  if (!work || !Array.isArray(work.write) || !Array.isArray(work.keep) || !Array.isArray(work.scan)) {
    log('malformed work payload — nothing done');
    return null;
  }

  const installed = [];
  let wrote = 0;
  let removed = 0;

  // ---- write the enabled set ----------------------------------------------
  for (const f of work.write) {
    const path = fileFor(f.scope, f.slug, f.dir);
    if (!path) continue;                     // nowhere to put it on this host
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* not there yet */ }
    // The trust rule, at the one place it can actually be enforced. A file that
    // exists and carries no marker is somebody else's: the library row stays
    // uninstalled, the report shows it unmanaged, and the app offers Adopt.
    //
    // `f.adopt` is the one exception, and it is not a loosening — it is the
    // rule working. The server sets it only for a row the owner pressed Adopt
    // on and which has never been written, so the file about to be overwritten
    // is the exact file they asked Stack to take over. It goes false the moment
    // this write is reported, so the licence is spent, not standing.
    if (current && !isManaged(current)) {
      if (!f.adopt) {
        log(`skipped ${path}: a CLAUDE.md is there and Stack did not write it (adopt it in the app to take it over)`);
        continue;
      }
      log(`adopting ${path}: taking over a hand-written file at the owner's request`);
    }
    if (current === f.content && f.installed) continue;   // steady state costs nothing
    if (dry) { log(`would write ${path}`); wrote++; continue; }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content, 'utf8');
      installed.push(f.id);
      wrote++;
    } catch (e) { log(`could not write ${path}: ${e.message}`); }
  }

  // ---- the roots to sweep and report --------------------------------------
  // Every project the server named, plus any repo the last report mentioned, so
  // a project whose files were all deleted still gets revisited rather than
  // keeping a stale report row forever.
  const slugs = new Set(work.scan.filter((s) => typeof s === 'string'));
  for (const k of work.keep) if (k?.scope === 'project' && k.slug) slugs.add(k.slug);
  let previous = [];
  try { previous = (await api('GET', '/api/instructions')).report?.files ?? []; }
  catch { /* the report is a nicety here */ }
  for (const p of previous) if (p?.scope === 'project' && p.slug) slugs.add(p.slug);

  const report = [...scanGlobal()];
  const cuts = [];
  for (const slug of [...slugs].sort()) {
    const repo = repoFor(slug);
    if (!repo) continue;
    const { files, truncated } = scanRepo(repo, slug);
    report.push(...files);
    if (truncated) cuts.push(slug);
  }

  // ---- remove what Stack planted and no longer wants -----------------------
  // Driven by the KEEP list, not by a diff against the last report: the server
  // does not know what is on disk, and a stale diff would delete a file that
  // had only just been written.
  const keep = new Set(work.keep.map((k) => `${k.scope}:${k.slug || ''}:${k.dir || ''}`));
  for (const found of report) {
    if (!found.managed) continue;                              // never ours to remove
    if (keep.has(`${found.scope}:${found.slug}:${found.dir}`)) continue;
    if (dry) { log(`would remove ${found.path}`); removed++; continue; }
    try {
      // Belt and braces before an unlink: re-read the file and confirm the
      // marker is still there. Cheap, and it closes the window between the scan
      // and now — in which somebody may have replaced the file by hand.
      if (!isManaged(readFileSync(found.path, 'utf8'))) continue;
      rmSync(found.path, { force: true });
      found.removed = true;
      removed++;
    } catch (e) { log(`could not remove ${found.path}: ${e.message}`); }
  }

  // ---- report what is actually there --------------------------------------
  const onDisk = report.filter((f) => !f.removed)
    .map(({ removed: _r, ...f }) => f);
  // A capped list inside a report has to SAY it is capped, and on the right
  // axis — a tree quietly missing a repo's deepest file reads as a tree that
  // does not have one.
  const cut = cuts.length ? ` · stopped at ${MAX_PER_REPO} files in ${cuts.join(', ')}` : '';
  const detail = dry
    ? `dry run — ${wrote} to write, ${removed} to remove${cut}`
    : `${wrote} written, ${removed} removed, ${onDisk.length} on disk${cut}`;
  if (!dry) {
    try { await api('POST', '/api/instructions/report', { files: onDisk, installed, detail }); }
    catch (e) { log(`report failed (${e.message})`); }
  }
  log(detail);
  return { wrote, removed, onDisk: onDisk.length, detail };
}

// The root `stack` dispatcher hands its main an argv ARRAY, so the flag is
// parsed here rather than in syncInstructions — which stays an options-object
// API for the autopilot dispatcher that imports it.
export async function main(argv = []) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  await syncInstructions({ dry: args.includes('--dry') });
  return 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith('stack-instructions.mjs');
if (invoked) {
  main(process.argv.slice(2)).catch((e) => { log(`failed: ${e.message}`); process.exit(1); });
}
