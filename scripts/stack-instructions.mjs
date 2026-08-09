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

// IS THIS FILE ONE STACK PLANTED? The marker must be the file's own LAST
// non-empty line — exactly where `instructionFile()` writes it — and nowhere
// else counts.
//
// This was `text.includes(MARKER)` and that is not a small difference: it made
// any file that MENTIONS the marker read as Stack's own. The file it deleted
// first was this repo's CLAUDE.md, which documents the marker in a sentence
// about how the marker works. A trust rule that a document can opt itself into
// by describing it is not a trust rule.
//
// So: last non-empty line, exact match after trimming, and nothing else. A file
// quoting the marker in prose, in a code fence, or in a rule about Stack itself
// is UNMANAGED, which is the direction this has to fail in — a leftover file
// somebody deletes by hand costs a minute, and a deleted file can cost a day.
export const isManaged = (text) => {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length > 0 && lines[lines.length - 1].trim() === MARKER;
};

// What the app edits: the file without Stack's bookkeeping line. Stripping it
// on the way IN is what keeps the marker out of the raw editor, so nobody can
// delete it by accident and orphan their own file. Only the TRAILING marker
// goes — a line inside the document that happens to be the marker is the
// owner's writing, by the same reasoning as above.
export const stripMarker = (text) => {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && lines[lines.length - 1].trim() === MARKER) lines.pop();
  return lines.join('\n').replace(/\s+$/, '');
};

// ONE `git ls-files` per repo, and everything the tree needs comes out of it:
// how many tracked files each directory reaches, and which directories exist at
// all. It used to be one git call per CLAUDE.md found, which is the same answer
// for more work — and it could not answer the question the app actually needed,
// which is "where COULD a nested file go", about directories that have no
// CLAUDE.md in them yet and so were never visited.
//
// `null` when git could not be asked (not a repo, git absent, a timeout). Every
// reader must treat that as UNKNOWN and never as zero: a repo reported as
// reaching no files reads as an empty repo, which is the NULL-verdict lie again.
function treeOf(repo) {
  let out = '';
  try {
    out = execFileSync('git', ['-C', repo, 'ls-files', '-z'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  } catch { return null; }

  const reach = new Map();  // dir ('' = root) -> tracked files at or under it
  const paths = out.split('\0').filter(Boolean);
  for (const p of paths) {
    const segs = p.split('/');
    segs.pop();                                   // the filename
    reach.set('', (reach.get('') || 0) + 1);
    // Every ancestor directory counts it, so a dir's reach is what a CLAUDE.md
    // placed there would actually govern — the whole subtree, not one level.
    let prefix = '';
    for (let i = 0; i < Math.min(segs.length, MAX_DEPTH); i++) {
      if (SKIP.has(segs[i])) break;
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
      reach.set(prefix, (reach.get(prefix) || 0) + 1);
    }
  }
  return reach;
}

// The directories a nested CLAUDE.md could sensibly go in: real, tracked, and
// deep enough to be worth scoping. Capped at DIR_CAP and ordered by reach, so
// what the picker offers first is what governs the most code.
//
// Depth is capped at 2 rather than MAX_DEPTH on purpose. A file five levels
// down governs almost nothing and is somewhere nobody looks; offering hundreds
// of them turns a destination picker into a filesystem browser, which is the
// thing it exists to replace.
const DIR_CAP = 40;
const OFFER_DEPTH = 2;
function candidateDirs(reach) {
  if (!reach) return [];
  return [...reach.entries()]
    .filter(([dir]) => dir && dir.split('/').length <= OFFER_DEPTH)
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
    .slice(0, DIR_CAP);
}

// Every CLAUDE.md under one repo, managed or not. Bounded by MAX_DEPTH,
// MAX_PER_REPO and the SKIP set; returns `{ files, truncated }` so the caller
// can say out loud that it stopped early.
function scanRepo(repo, slug, reach) {
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
          reach: reach ? (reach.get(rel) ?? 0) : -1,
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
  const repos = [];
  const cuts = [];
  for (const slug of [...slugs].sort()) {
    const repo = repoFor(slug);
    if (!repo) continue;
    const reach = treeOf(repo);
    const { files, truncated } = scanRepo(repo, slug, reach);
    report.push(...files);
    // Where a nested file COULD go, so the app can offer real destinations
    // instead of a text box. `dirs: []` with `known: false` says the host could
    // not ask git — the app then falls back to a free-text path rather than
    // showing an empty list, which would read as "this repo has no directories".
    repos.push({ slug, known: reach !== null, root: reach ? (reach.get('') ?? 0) : -1, dirs: candidateDirs(reach) });
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
    try { await api('POST', '/api/instructions/report', { files: onDisk, repos, installed, detail }); }
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
