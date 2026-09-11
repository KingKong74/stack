// What model actually ANSWERED in a session (#505).
//
// The gateway's combo routes (`auto`, `auto/coding`) are not models — they are
// a decision the gateway makes PER REQUEST, and it genuinely moves mid-session:
// one measured session here answered 99 times as `big-pickle` and twice as
// `mimo-v2.5-free`. So "what am I running on" has two different true answers
// and a rail row that shows only the route is answering the easier one.
//
// WHERE THE TRUTH IS. Claude Code stamps the responding model on every
// assistant line of its own JSONL transcript, because that is what the API
// returned. Nothing else on this host sees it: Stack does not proxy the
// traffic, and the gateway's request log needs the dashboard's admin session,
// which is a credential this has no business holding. The transcript is both
// exact and already ours to read — usage-meter.mjs and edit-watch.mjs have
// scanned these files for other reasons since #287.
//
// THE MAPPING IS THE HARD PART, and it is why the SessionStart hook writes one.
// A transcript is named for Claude Code's own session id, which nothing
// host-side can predict, and matching by cwd alone is wrong the moment two
// sessions share a checkout — which on this host is the normal case. The hook
// runs INSIDE the tmux pane, is handed `transcript_path` on stdin, and can ask
// tmux its own session name, so it is the one place both halves are known at
// once. Everything here is a READER of that file.
//
// FAIL SILENT, per CLAUDE.md: every failure returns '' and the row falls back
// to showing the route. A session whose model cannot be read must not be drawn
// as if it were on the route it ASKED for — that is the claim this exists to
// stop making — but neither may it invent one.
//
// Zero dependencies, pure stdlib, and safe to call on a 60s tick: each read is
// a bounded tail, never the whole file.

import { closeSync, openSync, readSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The map the hook writes and this reads: tmux session name -> the transcript
// Claude Code is writing in it. In ~/.stack because that is where the host
// keeps state the daemon and the hooks both touch.
export const MAP_FILE = join(homedir(), '.stack', 'term-transcripts.json');

// How much of the tail to read. An assistant line carrying a big tool result
// can be tens of KB, so this has to cover a few of them to be sure of catching
// one; it does not have to cover the file.
const TAIL_BYTES = 256 * 1024;
// Entries older than this are dropped when the map is written. A tmux session
// that lived a week is long gone, and an unbounded map is a file that only
// ever grows.
const MAP_TTL_MS = 14 * 24 * 60 * 60_000;
const MAP_MAX = 200;

export function readMap(file = MAP_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

// Record one session's transcript against the tmux session it runs in. Called
// by the hook, which is the only place both facts are known. Best-effort and
// never throws: the hook must exit 0 whatever happens here.
export function noteTranscript(tmuxName, transcript, { file = MAP_FILE, now = Date.now() } = {}) {
  if (!tmuxName || !transcript) return false;
  try {
    const map = readMap(file);
    map[String(tmuxName).slice(0, 80)] = { transcript: String(transcript).slice(0, 512), at: now };
    // Prune on WRITE rather than on read: the reader runs every minute and the
    // writer runs once per session, so the cost belongs to the writer.
    const rows = Object.entries(map)
      .filter(([, v]) => v && typeof v.at === 'number' && now - v.at < MAP_TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAP_MAX);
    writeFileSync(file, JSON.stringify(Object.fromEntries(rows)), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// The last model named in a transcript's tail, or '' when there is nothing to
// read. `model` appears on assistant lines only, so the last one is the model
// that answered most recently — which is the honest answer for a route that
// can change between requests.
export function lastModelIn(path, { tailBytes = TAIL_BYTES } = {}) {
  let fd = -1;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // Last match wins. A plain regex over the tail rather than a line-by-line
    // JSON parse: the first line of a tail read is usually a fragment, and
    // parsing is both slower and no more correct for one string field.
    let out = '';
    const re = /"model"\s*:\s*"([^"]{1,120})"/g;
    let m;
    while ((m = re.exec(text)) !== null) out = m[1];
    return out;
  } catch {
    return '';
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

// What a tmux session is ACTUALLY answering as, '' when unknown. The two
// failure modes are deliberately indistinguishable to the caller because they
// mean the same thing to a reader: Stack cannot say.
export function resolvedModelFor(tmuxName, { file = MAP_FILE } = {}) {
  const row = readMap(file)[tmuxName];
  return row?.transcript ? lastModelIn(row.transcript) : '';
}
