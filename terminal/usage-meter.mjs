// Today's Claude token usage, read from the transcripts Claude Code writes
// under ~/.claude/projects/**/*.jsonl on THIS host — the same numbers the
// autopilot meters from `claude -p` usage, but live and account-wide (input +
// output + cache creation + cache read, matching the runner's counting).
//
// The meter is incremental: each file is read once from its last offset, so
// the first read of the day pays the full scan and every later read only
// parses appended bytes. Assistant messages can be re-written across lines as
// a turn streams — the LAST usage line for a message id wins, so totals track
// the final per-message numbers, never double-counted.
//
// Zero dependencies (like the rest of terminal/), pure stdlib.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function createUsageMeter({ root } = {}) {
  const ROOT = root || join(homedir(), '.claude', 'projects');

  let day = '';            // local YYYY-MM-DD the counters describe
  let files = new Map();   // path -> { offset, tail }
  let perMsg = new Map();  // message.id -> latest { tot, fresh } for it
  let total = 0;           // input + output + cache write + cache READ
  let fresh = 0;           // input + output + cache write — the number that
                           // tracks real work; cache reads dwarf it ~30:1 (#130)

  const localDay = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function rollover() {
    const today = localDay();
    if (day === today) return;
    day = today;
    files = new Map();
    perMsg = new Map();
    total = 0;
    fresh = 0;
  }

  function addLine(line) {
    if (!line.includes('"usage"')) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (j?.type !== 'assistant') return;
    const u = j.message?.usage;
    const id = j.message?.id;
    if (!u || !id) return;
    if (localDay(new Date(j.timestamp || 0)) !== day) return;
    const f = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const tokens = f + (u.cache_read_input_tokens || 0);
    const prev = perMsg.get(id) || { tot: 0, fresh: 0 };
    total += tokens - prev.tot;
    fresh += f - prev.fresh;
    perMsg.set(id, { tot: tokens, fresh: f });
  }

  function scanFile(path, size) {
    const st = files.get(path) || { offset: 0, tail: '' };
    if (size <= st.offset) return;
    let fd;
    try { fd = openSync(path, 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(size - st.offset);
      const n = readSync(fd, buf, 0, buf.length, st.offset);
      st.offset += n;
      const lines = (st.tail + buf.toString('utf8', 0, n)).split('\n');
      st.tail = lines.pop() || '';
      for (const line of lines) addLine(line);
      files.set(path, st);
    } catch { /* a vanished file just drops out */ } finally { closeSync(fd); }
  }

  // Returns today's counts: { total, fresh } — total includes cache reads,
  // fresh is input + output + cache writes (the honest "work done" number,
  // #130: cache reads are ~97% of total and made the strip read as wrong).
  // Never throws — an unreadable transcript tree simply reports what it has
  // (zeros on a host with no ~/.claude).
  function read() {
    rollover();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    let dirs = [];
    try { dirs = readdirSync(ROOT); } catch { return { total, fresh }; }
    for (const dir of dirs) {
      let names = [];
      try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(ROOT, dir, name);
        let st;
        try { st = statSync(path); } catch { continue; }
        // Untouched-since-yesterday files can't hold today's usage — skip the
        // cold read; once tracked, keep following (offset already past the old bytes).
        if (st.mtimeMs < dayStart.getTime() && !files.has(path)) continue;
        scanFile(path, st.size);
      }
    }
    return { total, fresh };
  }

  return { read };
}
