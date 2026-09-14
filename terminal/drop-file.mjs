// Where a file dragged onto a terminal pane lands on the host (#511).
//
// Dropping an image on a native terminal types its PATH into the session —
// that is the whole gesture, and it is how you hand Claude Code a screenshot.
// A browser tab has no path to type: the file exists in the page, not on this
// machine. So the drop has to become a real file here first, and this module
// is the only thing that decides where and under what name.
//
// The rules, and why each one:
//
//  • NEVER THE SESSION'S CWD. Every claude tab is open in a repo, and a
//    silently-appearing `shot.png` in somebody's working tree is a file they
//    will commit by accident. Drops go to ~/.stack/drops — Stack's own
//    directory, the one place here it already owns. (The cost, stated rather
//    than discovered: a path outside the workspace is a read claude may ask
//    permission for, exactly as it would for a file dragged from ~/Downloads.)
//  • THE NAME IS REBUILT, NEVER TRUSTED. `name` comes off a File object in a
//    browser, which is to say from whatever the page was handed. Only the
//    basename survives, and only `[A-Za-z0-9._-]` of that — so there is no
//    separator left to traverse with and no leading dot to hide behind. The
//    join is then checked AGAIN against the directory, because a sanitiser
//    that is wrong is worth catching twice.
//  • AN EXISTING NAME IS NEVER OVERWRITTEN. `wx` is the exclusive create, so
//    two panes dropping `screenshot.png` in the same second cannot race into
//    one file: the loser takes the next suffix. The suffix is `-2`, `-3` …
//    rather than a hash because the path gets TYPED INTO A PROMPT and read
//    back by a human.
//  • THE CAP IS ENFORCED HERE TOO. The browser checks the size before it
//    sends and the relay checks the frame, but this process is the one that
//    writes, so it re-checks rather than trusting either.
//
// Pruning deletes, so it follows the fail-safe direction in CLAUDE.md: it only
// ever touches plain files directly inside ~/.stack/drops, it takes nothing it
// could not stat, and a directory it cannot read is left entirely alone.
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// 10 MB. Big enough for any screenshot or phone photo, small enough that one
// frame through the relay is still just a frame.
export const DROP_MAX_BYTES = 10 * 1024 * 1024;

// A week. A drop is a hand-off, not an archive — but a path typed into a
// prompt this morning must still resolve this evening.
export const DROP_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// A function, not a constant, so a test can call it without $HOME being set at
// import time (same reason as agentScratchDir).
export function dropsDir() {
  return join(homedir(), '.stack', 'drops');
}

// The handful of types a drop is actually likely to be, for the one case the
// extension has to be INVENTED: a file whose name carries none. Claude Code
// decides whether something is an image by its extension, so a screenshot
// arriving as `pasted` would be read as text and the drop would silently do
// nothing useful.
const EXT_FOR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
};

// The basename, reduced to something that cannot mean anything but a filename.
export function safeName(name, mime = '') {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  let s = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')   // one class, everything else collapses
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')             // no `..`, at any position
    .replace(/^[.-]+/, '')               // no dotfile, no leading dash
    .slice(0, 60)
    .replace(/[.-]+$/, '');
  if (!s) s = 'drop';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(s)) s += EXT_FOR_MIME[String(mime).toLowerCase()] || '.bin';
  return s;
}

// Split at the LAST dot, so `a.tar.gz` suffixes as `a.tar-2.gz` rather than
// losing half its name.
const splitExt = (s) => {
  const i = s.lastIndexOf('.');
  return i > 0 ? [s.slice(0, i), s.slice(i)] : [s, ''];
};

// Write one dropped file. `data` is base64 — the wire carries every byte that
// way, exactly like terminal output.
export function writeDrop({ name, mime, data, dir = dropsDir(), maxBytes = DROP_MAX_BYTES }) {
  let buf;
  try {
    buf = Buffer.from(String(data || ''), 'base64');
  } catch {
    return { ok: false, error: 'that file did not arrive intact' };
  }
  if (!buf.length) return { ok: false, error: 'that file was empty' };
  if (buf.length > maxBytes) {
    return { ok: false, error: `that file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB drop limit` };
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not open the drops folder on the host: ${e.message}` };
  }

  const clean = safeName(name, mime);
  const [stem, ext] = splitExt(clean);
  const root = resolve(dir);
  for (let n = 1; n <= 64; n++) {
    const candidate = n === 1 ? clean : `${stem}-${n}${ext}`;
    const full = resolve(dir, candidate);
    // The second check: the sanitiser says this is a bare filename, and this
    // says the join agreed.
    if (full !== join(root, candidate) || !full.startsWith(root + sep)) {
      return { ok: false, error: 'that filename could not be made safe' };
    }
    try {
      writeFileSync(full, buf, { flag: 'wx' });
      prune(dir);
      return { ok: true, path: full, name: candidate, bytes: buf.length };
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      return { ok: false, error: `could not write the drop on the host: ${e.message}` };
    }
  }
  return { ok: false, error: 'too many files by that name are already waiting in ~/.stack/drops' };
}

// Old drops, and nothing else: plain files, directly in this directory, whose
// age this process could actually read. Best effort throughout — a prune that
// fails must never fail the drop it was cleaning up after.
export function prune(dir = dropsDir(), keepMs = DROP_KEEP_MS, now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    if (!existsSync(dir)) return 0;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(dir, e.name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (now - st.mtimeMs <= keepMs) continue;
    try { unlinkSync(full); removed++; } catch { /* still there next time */ }
  }
  return removed;
}
