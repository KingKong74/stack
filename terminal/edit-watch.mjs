// Who is editing which file, right now.
//
// Stack has always known which files a session touched — but only at
// SessionEnd, from the transcript the hook parses on the way out
// (hook/stack-session-end.mjs, files_touched). That is history. It cannot tell
// you that two sessions are, at this moment, both rewriting schema.sql in the
// same checkout, which is the collision that costs a rebase and occasionally
// costs the work.
//
// So this is the same read, live. It tails the very JSONL transcripts Claude
// Code is writing under ~/.claude/projects/**, using the incremental
// byte-offset scan the usage meter already proved out next door: each file is
// read once from where the last read stopped, so a 60s tick parses only the
// bytes that arrived in the last 60 seconds.
//
// The line shape is not guessed. It is the one hook/stack-session-end.mjs has
// parsed since the beginning — `message.content[]` blocks of `type:'tool_use'`
// whose `input.file_path` names the target — plus the envelope fields Claude
// Code stamps on every line: sessionId, cwd, gitBranch, timestamp.
//
// Zero dependencies (like the rest of terminal/), pure stdlib.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

// The tools that WRITE. Read/Grep/Glob touching a file is not a collision, and
// counting them would make every session look like it was editing everything.
// Same list the SessionEnd hook derives files_touched from.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace', 'create_file']);

// How far back an edit still means "is editing this". Long enough to cover a
// session thinking between two edits of the same file, short enough that
// yesterday's work is not a collision.
const WINDOW_MS = 45 * 60_000;
// The most files one session reports. A big refactor touches hundreds and
// none of them past the newest few dozen are what a collision warning is
// about; the count of what was dropped rides along so nothing is silently cut.
const FILES_PER_SESSION = 60;
// A transcript first seen mid-life is read from its last 2 MB, not its start.
// Only the window matters, and a months-old transcript can be very large.
const COLD_TAIL_BYTES = 2 * 1024 * 1024;

export function createEditWatch({ root, windowMs = WINDOW_MS } = {}) {
  const ROOT = root || join(homedir(), '.claude', 'projects');

  const files = new Map();     // transcript path -> { offset, tail }
  const live = new Map();      // sessionId -> { cwd, branch, lastAt, edits: Map<path, ms>, dropped }

  function addLine(line) {
    if (!line.includes('"sessionId"')) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    const sid = j.sessionId || j.session_id;
    if (!sid) return;
    const at = Date.parse(j.timestamp || '') || 0;
    if (!at) return;

    let s = live.get(sid);
    if (!s) { s = { cwd: '', branch: '', lastAt: 0, edits: new Map(), dropped: 0 }; live.set(sid, s); }
    if (j.cwd) s.cwd = j.cwd;
    if (j.gitBranch) s.branch = j.gitBranch;
    // Any line at all is a sign of life — a session deep in a long tool call
    // is still going even though it has not written a file for ten minutes.
    if (at > s.lastAt) s.lastAt = at;

    const content = j.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const path = b.input?.file_path || b.input?.path || b.input?.notebook_path;
      if (typeof path !== 'string' || !path) continue;
      s.edits.set(path, Math.max(at, s.edits.get(path) || 0));
    }
  }

  function scanFile(path, size) {
    let st = files.get(path);
    if (!st) {
      // Cold start on a file already in flight: skip to its tail rather than
      // parsing a transcript that may be tens of megabytes of history.
      const from = size > COLD_TAIL_BYTES ? size - COLD_TAIL_BYTES : 0;
      // A mid-line start would parse one corrupt line; dropping to the next
      // newline is what `tail` marker below does (first split chunk discarded).
      st = { offset: from, tail: '', partial: from > 0 };
      files.set(path, st);
    }
    if (size <= st.offset) return;
    let fd;
    try { fd = openSync(path, 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(size - st.offset);
      const n = readSync(fd, buf, 0, buf.length, st.offset);
      st.offset += n;
      const lines = (st.tail + buf.toString('utf8', 0, n)).split('\n');
      st.tail = lines.pop() || '';
      if (st.partial) { lines.shift(); st.partial = false; }
      for (const line of lines) addLine(line);
    } catch { /* a vanished transcript just drops out */ } finally { closeSync(fd); }
  }

  function prune(now) {
    const floor = now - windowMs;
    for (const [sid, s] of live) {
      for (const [p, at] of s.edits) if (at < floor) s.edits.delete(p);
      if (s.lastAt < floor && s.edits.size === 0) live.delete(sid);
    }
  }

  /**
   * Sessions that have written a file inside the window, newest edit first.
   *
   * Paths come back RELATIVE to the session's cwd — that is the form a human
   * reads ("db/schema.sql", not "/home/bailey/stack/db/schema.sql") and the
   * form two sessions in the same checkout can be compared on. A file outside
   * the cwd keeps its absolute path, because relative would be a lie about
   * where it is.
   *
   * Never throws: no ~/.claude on this host simply reports nothing.
   */
  function read(now = Date.now()) {
    const floor = now - windowMs;
    let dirs = [];
    try { dirs = readdirSync(ROOT); } catch { return []; }
    for (const dir of dirs) {
      let names = [];
      try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(ROOT, dir, name);
        let st;
        try { st = statSync(path); } catch { continue; }
        // Untouched inside the window and not already tracked — it cannot hold
        // a current edit, so skip the cold read entirely.
        if (st.mtimeMs < floor && !files.has(path)) continue;
        scanFile(path, st.size);
      }
    }
    prune(now);

    const out = [];
    for (const [sessionId, s] of live) {
      if (!s.edits.size) continue;
      const all = [...s.edits.entries()].sort((a, b) => b[1] - a[1]);
      const shown = all.slice(0, FILES_PER_SESSION);
      out.push({
        sessionId,
        cwd: s.cwd,
        branch: s.branch,
        lastAt: s.lastAt,
        dropped: all.length - shown.length,
        files: shown.map(([p, at]) => ({ path: rel(p, s.cwd), at })),
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  return { read };
}

function rel(path, cwd) {
  if (!cwd || !isAbsolute(path)) return path;
  const r = relative(cwd, path);
  return !r || r.startsWith('..') ? path : r;
}
