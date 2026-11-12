// The host's half of the file exchange (server/src/routes/files.js has the
// whole picture). Every project gets a folder on this host:
//
//   ~/.stack/files/<slug>/inbox/    what the owner shared WITH sessions (read it)
//   ~/.stack/files/<slug>/outbox/   what a session hands BACK (write it here)
//
// One `syncFiles()` pass, run on a timer by stack-term.mjs, mirrors the
// server's shared files into each inbox and uploads every new or changed
// outbox file. The daemon dials out for both: the server never reaches here.
//
// The rules, and why each one:
//
//  • NEVER A REPO. Like drops (drop-file.mjs), the folders live under
//    ~/.stack, so a shared screenshot can't be committed by accident.
//  • THE SERVER NAMES INBOX FILES, AND THEY ARE CHECKED AGAIN HERE. `hostName`
//    must be `<id>-<plain name>` and the slug a plain slug, or the entry is
//    skipped: a bad name from the wire never becomes a path.
//  • DELETION FAILS SAFE. An inbox file is removed only when (a) the list was
//    actually fetched this pass and (b) the manifest says THIS module put it
//    there. A file somebody else left in an inbox is never touched, and an
//    unreachable server removes nothing. The outbox is never deleted from:
//    it is the session's work.
//  • A HALF-WRITTEN OUTBOX FILE IS NOT SENT. A file modified in the last few
//    seconds waits for the next pass; an inbox download lands under a dot
//    name and is renamed into place, so a session never reads half of one.
//  • THE MANIFEST IS MEMORY, NOT TRUTH. `.sync.json` records what was
//    downloaded (by updatedAt) and uploaded (by sha256), only so nothing is
//    re-sent every pass. Losing it costs one re-download and one no-op upload
//    per file (the server ignores identical bytes).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

export const FILE_SYNC_MAX_BYTES = 10 * 1024 * 1024;
export const SETTLE_MS = 3000;

export const filesDir = () => join(homedir(), '.stack', 'files');

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const HOST_NAME_RE = /^[0-9]+-[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The server's outbox route refuses anything its own sanitiser would change,
// so only names already in this shape are sent; anything else is reported.
const OUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const isSafeSlug = (s) => SLUG_RE.test(String(s)) && !String(s).includes('..');
export const isSafeHostName = (s) => HOST_NAME_RE.test(String(s)) && !String(s).includes('..') && !/[.-]$/.test(String(s));
export const isSafeOutName = (s) => OUT_NAME_RE.test(String(s)) && !String(s).includes('..') && !/[.-]$/.test(String(s));

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip',
};
export const mimeOf = (name) => MIME[extname(name).toLowerCase()] || 'application/octet-stream';

function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, '.sync.json'), 'utf8'));
    return { inbox: m.inbox && typeof m.inbox === 'object' ? m.inbox : {}, outbox: m.outbox && typeof m.outbox === 'object' ? m.outbox : {} };
  } catch { return { inbox: {}, outbox: {} }; }
}
function writeManifest(dir, m) {
  try {
    writeFileSync(join(dir, '.sync.json.tmp'), JSON.stringify(m));
    renameSync(join(dir, '.sync.json.tmp'), join(dir, '.sync.json'));
  } catch { /* next pass re-sends at worst */ }
}

/**
 * One pass. `api(path, init)` is a fetch bound to the server and the token,
 * resolving to a Response. Returns counts plus messages worth logging.
 */
export async function syncFiles({ api, dir = filesDir(), now = Date.now(), maxBytes = FILE_SYNC_MAX_BYTES }) {
  const out = { downloaded: 0, removed: 0, uploaded: 0, notes: [] };
  let list;
  try {
    const res = await api('/api/files/sync');
    if (!res.ok) { out.notes.push(`files: sync list refused (${res.status}); doing nothing`); return out; }
    list = await res.json();
  } catch (e) {
    out.notes.push(`files: server unreachable (${e.message}); doing nothing`);
    return out;
  }
  if (!list || !Array.isArray(list.projects) || !Array.isArray(list.inbox)) {
    out.notes.push('files: sync list malformed; doing nothing');
    return out;
  }
  try { mkdirSync(dir, { recursive: true }); } catch (e) { out.notes.push(`files: cannot make ${dir}: ${e.message}`); return out; }
  const m = readManifest(dir);

  const slugs = list.projects.filter(isSafeSlug);
  for (const slug of slugs) {
    try {
      mkdirSync(join(dir, slug, 'inbox'), { recursive: true });
      mkdirSync(join(dir, slug, 'outbox'), { recursive: true });
    } catch { /* reported below if it matters */ }
  }

  // ---- inbox: mirror down ----
  const want = new Map();
  for (const e of list.inbox) {
    if (!e || !isSafeSlug(e.slug) || !isSafeHostName(e.hostName) || !slugs.includes(e.slug)) continue;
    want.set(`${e.slug}/${e.hostName}`, e);
  }
  for (const [key, e] of want) {
    const target = join(dir, e.slug, 'inbox', e.hostName);
    if (m.inbox[key] === String(e.updatedAt) && existsSync(target)) continue;
    if (Number(e.size) > maxBytes) continue;
    try {
      const res = await api(`/api/projects/${encodeURIComponent(e.slug)}/artifacts/${Number(e.id)}/file`);
      if (!res.ok) { out.notes.push(`files: could not fetch ${key} (${res.status})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const part = join(dir, e.slug, 'inbox', `.${e.hostName}.part`);
      writeFileSync(part, buf);
      renameSync(part, target);
      m.inbox[key] = String(e.updatedAt);
      out.downloaded++;
    } catch (err) { out.notes.push(`files: could not write ${key}: ${err.message}`); }
  }
  // Only what this module planted, and only now that the list is known.
  for (const key of Object.keys(m.inbox)) {
    if (want.has(key)) continue;
    const [slug, name] = key.split('/');
    if (!isSafeSlug(slug) || !isSafeHostName(name)) { delete m.inbox[key]; continue; }
    try {
      const p = join(dir, slug, 'inbox', name);
      if (existsSync(p) && statSync(p).isFile()) { unlinkSync(p); out.removed++; }
      delete m.inbox[key];
    } catch { /* try again next pass */ }
  }

  // ---- outbox: send up ----
  const seen = new Set();
  for (const slug of slugs) {
    let entries;
    try { entries = readdirSync(join(dir, slug, 'outbox'), { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || ent.name.startsWith('.')) continue;
      const key = `${slug}/${ent.name}`;
      seen.add(key);
      const full = join(dir, slug, 'outbox', ent.name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (now - st.mtimeMs < SETTLE_MS || st.size === 0) continue;
      const tooBig = st.size > maxBytes;
      const badName = !isSafeOutName(ent.name);
      if (tooBig || badName) {
        const mark = `skip:${st.size}:${st.mtimeMs}`;
        if (m.outbox[key] !== mark) {
          out.notes.push(`files: not sending ${key}: ${tooBig ? `over the ${maxBytes / 1048576} MB cap` : 'rename it to letters, digits, . _ -'}`);
          m.outbox[key] = mark;
        }
        continue;
      }
      let buf;
      try { buf = readFileSync(full); } catch { continue; }
      const sha = createHash('sha256').update(buf).digest('hex');
      if (m.outbox[key] === sha) continue;
      try {
        const res = await api(`/api/files/${encodeURIComponent(slug)}/out/${encodeURIComponent(ent.name)}`, {
          method: 'PUT', body: buf, headers: { 'content-type': mimeOf(ent.name) },
        });
        if (!res.ok) { out.notes.push(`files: upload of ${key} refused (${res.status})`); continue; }
        m.outbox[key] = sha;
        out.uploaded++;
      } catch (err) { out.notes.push(`files: upload of ${key} failed: ${err.message}`); }
    }
  }
  // A file the session removed is forgotten, so writing it again re-sends.
  for (const key of Object.keys(m.outbox)) if (!seen.has(key)) delete m.outbox[key];

  writeManifest(dir, m);
  return out;
}
