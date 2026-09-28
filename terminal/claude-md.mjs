// claude-md.mjs — the host half of Mission Control → Context's CLAUDE.md rows.
//
// Pure file work, no uplink: stack-term.mjs answers the server's 'claudeMd' and
// 'claudeMdWrite' frames with these, and server/test/claude-md.test.mjs pins
// them against a temp directory.
//
// WHY THIS IS SHAPED THE WAY IT IS. Stack once held a copy of each repo's
// CLAUDE.md in its database and wrote it back every five minutes. A stale copy
// silently reverted this repo's own file for several sessions running. So:
//
//   • NOTHING IS STORED. The server asks, this reads the file on disk, the
//     browser shows it. There is no copy to go stale.
//   • A WRITE IS ONE HUMAN'S SAVE, NEVER A SCHEDULE. Nothing calls
//     writeClaudeMd except the route behind the Save button.
//   • A WRITE IS GUARDED BY THE HASH THE EDITOR OPENED. If the file changed on
//     disk since (a session edited it, a pull landed), the save is REFUSED and
//     says so. It never overwrites what it did not show you.
//   • A TRUNCATED READ CANNOT BE SAVED. Its hash covers the whole file, so a
//     save built from the visible part would be refused anyway; `truncated`
//     lets the browser say why before anyone types.
//   • ONLY A FILE NAMED CLAUDE.md, ALREADY THERE, INSIDE THE CHECKOUT. No
//     creating, no renaming, no path that resolves (through `..` or a symlink)
//     outside $root/<slug>.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export const FILE_NAME = 'CLAUDE.md';
// Caps, stated to the reader by the fields that carry them (`truncated`,
// `more`), never silently.
export const MAX_READ_BYTES = 200_000;
export const MAX_WRITE_BYTES = 200_000;
export const MAX_FILES_PER_REPO = 30;
export const MAX_DEPTH = 4;
// Directories no repo's own CLAUDE.md lives in, and which are slow to walk.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', 'coverage', '.venv', '__pycache__']);

export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const cleanSlug = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');

// Every CLAUDE.md under `dir`, root first, then shallowest and alphabetical.
// Symlinked directories are not followed.
function findFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isFile() && e.name === FILE_NAME) out.push(relative(dir, join(d, e.name)));
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
}

// A repo that budgets its CLAUDE.md files (Stack does, in
// scripts/context-budget.test.mjs) gets each file's cap shown beside its size.
// Read by pattern, never executed: it is a test file in somebody's repo.
function readBudgets(dir) {
  const out = new Map();
  try {
    const src = readFileSync(join(dir, 'scripts', 'context-budget.test.mjs'), 'utf8');
    for (const m of src.matchAll(/path:\s*'([^']+)',\s*max:\s*([\d_]+)/g)) out.set(m[1], Number(m[2].replace(/_/g, '')));
  } catch { /* no budget file: no budgets, which is the common case */ }
  return out;
}

// Every live project's CLAUDE.md files. A slug with no checkout on this host is
// reported as such (`checkout:false`), never dropped: "not here" and "has none"
// are different answers.
export function listClaudeMd({ root, slugs }) {
  return (Array.isArray(slugs) ? slugs : []).map((raw) => {
    const slug = cleanSlug(raw);
    const dir = join(root, slug);
    if (!slug || !existsSync(join(dir, '.git'))) return { slug: String(raw || ''), checkout: false, files: [], more: 0 };
    const budgets = readBudgets(dir);
    const all = findFiles(dir);
    const files = all.slice(0, MAX_FILES_PER_REPO).map((path) => {
      const buf = readFileSync(join(dir, path));
      const truncated = buf.length > MAX_READ_BYTES;
      return {
        path: path.split(sep).join('/'),
        bytes: buf.length,
        sha: sha(buf),
        body: (truncated ? buf.subarray(0, MAX_READ_BYTES) : buf).toString('utf8'),
        truncated,
        budget: budgets.get(path.split(sep).join('/')) ?? null,
      };
    });
    return { slug, checkout: true, files, more: Math.max(0, all.length - files.length) };
  });
}

// One human's Save. Returns { ok, error, sha, bytes }; `error` is shown
// verbatim, so it says what happened in words the owner can act on.
export function writeClaudeMd({ root, slug: rawSlug, path, sha: expected, body }) {
  const slug = cleanSlug(rawSlug);
  const fail = (error) => ({ ok: false, error, sha: '', bytes: 0 });
  if (!slug || slug !== rawSlug) return fail('That is not a project slug.');
  if (typeof body !== 'string') return fail('Nothing to save.');
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return fail('The save carried no version of the file to check against. Reload and try again.');
  const rel = String(path || '');
  if (basename(rel) !== FILE_NAME || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '')) {
    return fail('Only a file named CLAUDE.md inside the project can be saved here.');
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_WRITE_BYTES) return fail(`That is ${bytes.toLocaleString()} bytes; the cap is ${MAX_WRITE_BYTES.toLocaleString()}.`);

  const dir = join(root, slug);
  const file = join(dir, ...rel.split('/'));
  let realDir, realFile;
  try {
    realDir = realpathSync(dir);
    if (lstatSync(file).isSymbolicLink()) return fail('That CLAUDE.md is a symlink, which this does not write through.');
    realFile = realpathSync(file);
  } catch {
    return fail(`${rel} is not on disk in ${slug}'s checkout. This edits files that exist; it never creates one.`);
  }
  if (!realFile.startsWith(realDir + sep)) return fail('That path resolves outside the project checkout.');

  const current = readFileSync(realFile);
  if (sha(current) !== expected) {
    return fail(`${rel} changed on disk since you opened it (a session or a pull wrote it). Nothing was saved. Copy your text, reload, and apply it again.`);
  }
  // Atomic: a half-written CLAUDE.md is read by the next session that starts.
  const tmp = `${realFile}.stack-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: statSync(realFile).mode & 0o777 });
    renameSync(tmp, realFile);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    return fail(`The host could not write ${rel}: ${e.message}`);
  }
  return { ok: true, error: '', sha: sha(Buffer.from(body, 'utf8')), bytes };
}
