// THE TERMINAL DAEMON'S HOT PATH, MEASURED.
//
//   node scripts/term-perf.test.mjs              # exits non-zero on a regression
//   node scripts/term-perf.test.mjs --report     # numbers only, always exits 0
//
// Needs python3 (for the real pty-shim) and nothing else — no database, no
// API, no running daemon, no network. It spawns the SAME shim stack-term.mjs
// spawns and pushes the output through the SAME outbox, so what it measures is
// the pipeline that actually runs, not a model of it.
//
// WHY A PERF TEST AT ALL, when server/test/out-coalesce.test.mjs already pins
// the behaviour: because the failure this guards against does not look like a
// bug. Every correctness test still passes if somebody replaces the outbox
// with `ship(chunk)` on every read — the bytes all arrive, in order, intact.
// What changes is that a busy session goes from one websocket frame per 6ms to
// one per kernel read, and the terminal starts feeling like a mock of a
// terminal. That is a number, so it needs a test that reads numbers.
//
// HOW IT DECIDES. Two different kinds of claim, held to two different
// standards, because a shared host makes wall-clock assertions flaky and a
// flaky test gets ignored, which is worse than no test:
//
//   • STRUCTURAL claims are exact and hard. "An isolated chunk ships in the
//     same tick", "a burst of N chunks is far fewer than N frames" — these are
//     properties of the algorithm, true on any hardware under any load, and a
//     failure is a real regression.
//   • COST claims carry ORDER-OF-MAGNITUDE floors, set roughly 10x below what
//     this host actually does. They catch "somebody made framing 50x slower",
//     which is the regression worth catching, and they do not fire because the
//     host was busy. Every measured number is PRINTED whatever happens, so the
//     trend is readable even when nothing fails.
//
// VALIDATED BY MUTATION, because a perf test that cannot fail is decoration.
// Four regressions were introduced into terminal/out-coalesce.mjs on purpose
// and this suite was run against each:
//
//   ship on every push (no coalescing)  → 3 checks fail; 20000 chunks → 20000
//                                         frames, and the real pty flood
//                                         collapses 0%
//   a plain setTimeout(flush, window)   → echo latency p50 goes 0.03ms → 6.15ms
//   concat the pending buffer per push  → burst gather 5.7M → 0.05M chunks/s
//   an unbounded replay buffer          → 235KB held → 427MB held
//
// The plain-timer one is why section C times PUSH TO SHIP rather than how long
// push takes to return: measured the latter way, that mutant passed the whole
// suite. If you add a check here, mutate the thing it claims to protect and
// watch it go red first.
//
// AND IT FAILS LOUD. No python3, no shim, a spawn that dies — exit 1 naming
// the reason, never a quiet skip that reports zero findings. A perf suite that
// says nothing because it could not look is the NULL-verdict lie in another
// costume.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutbox, createReplayBuffer, OUT_COALESCE_MS } from '../terminal/out-coalesce.mjs';

const REPORT_ONLY = process.argv.includes('--report');
const SHIM = join(dirname(fileURLToPath(import.meta.url)), '..', 'terminal', 'pty-shim.py');

let fails = 0;
const rows = [];
// A measured number, printed whether or not it is also asserted on.
const measure = (name, value, unit) => { rows.push({ name, value, unit }); return value; };
const check = (name, ok, detail = '') => {
  if (!ok && !REPORT_ONLY) fails++;
  console.log(`${ok ? 'ok  ' : (REPORT_ONLY ? 'note' : 'FAIL')}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const die = (why) => { console.error(`\nCANNOT MEASURE: ${why}`); process.exit(1); };
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---- preflight: refuse to report nothing ----------------------------------

if (spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status !== 0) {
  die('python3 with the pty module is not available — the shim cannot run, so nothing here was measured.');
}

console.log(`terminal daemon — hot path\ncoalescing window: ${OUT_COALESCE_MS}ms\n`);

// ---- A. framing cost -------------------------------------------------------
//
// The per-byte work the daemon does on every frame: base64 it, wrap it in the
// JSON envelope the relay forwards. This is the floor on how fast a session
// can possibly talk, and it is the thing that changes if somebody swaps the
// encoding for something tidier.
{
  const MB = 8;
  const payload = Buffer.alloc(MB * 1024 * 1024, 'x');
  const slices = [];
  for (let i = 0; i < payload.length; i += 65536) slices.push(payload.subarray(i, i + 65536));
  const t0 = process.hrtime.bigint();
  let sunk = 0;
  for (const s of slices) sunk += JSON.stringify({ t: 'out', sid: 'p', data: s.toString('base64') }).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rate = measure('framing throughput', (MB * 1000) / ms, 'MB/s');
  measure('frame overhead', sunk / payload.length, 'x raw');
  check('framing keeps up with anything a pty can produce', rate > 20,
    `${fmt(rate)} MB/s (floor 20)`);
}

// ---- B. frame amplification under a repaint burst --------------------------
//
// What a claude session's spinner looks like to the daemon: many tiny writes,
// back to back, no gaps. THE headline number — before the outbox this was one
// websocket frame per item.
{
  const CHUNKS = 20000;
  // Allocated UP FRONT so the timing measures the outbox and not Buffer.from.
  const chunks = Array.from({ length: CHUNKS }, (_, i) => Buffer.from(`\x1b[G ${i} \x1b[K`));
  const sent = [];
  const box = createOutbox((b64) => sent.push(b64));
  // Gather and flush are timed APART. Together they read as one number that
  // is really two — the per-push cost this section is guarding, and a base64
  // encode of the whole burst that belongs to section A — and averaging them
  // hid the very regression this section exists to catch.
  const t0 = process.hrtime.bigint();
  for (const c of chunks) box.push(c);
  const gatherMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  box.flush();
  measure('burst flush cost', Number(process.hrtime.bigint() - t1) / 1e6, 'ms');
  const ratio = measure('burst amplification', CHUNKS / sent.length, ': 1 chunks per frame');
  // chunks-per-ms / 1000 = millions per second.
  const rate = measure('burst gather cost', (CHUNKS / gatherMs) / 1000, 'M chunks/s');
  check('a repaint burst does not become one frame per write', sent.length < CHUNKS / 10,
    `${CHUNKS} chunks → ${sent.length} frames (${fmt(ratio)}:1)`);
  const joined = Buffer.concat(sent.map((b) => Buffer.from(b, 'base64'))).toString('utf8');
  check('…and the burst is intact at both ends',
    joined.includes(' 0 ') && joined.includes(` ${CHUNKS - 1} `));
  // THE QUADRATIC GUARD, and the reason this row carries a threshold at all.
  // The first cut of the outbox concatenated the pending buffer on every push,
  // copying everything gathered so far each time. Over this same 20k burst
  // that measured 415ms against 2.9ms for the list-and-join it became — and
  // the gap grows with burst length, because one is quadratic and the other is
  // linear. NO CORRECTNESS TEST COULD SEE IT: every byte arrived, in order,
  // intact. The floor sits an order of magnitude under what this host does
  // (~5-7M/s) and two orders above the quadratic version (0.05M/s), so it can
  // fire on that mistake returning and on very little else.
  check('gathering a burst is linear in its length, not quadratic', rate > 1,
    `${fmt(rate)}M chunks/s (floor 1 — a per-push concat measures 0.05)`);
}

// ---- C. echo latency -------------------------------------------------------
//
// THE ONE A TIMER-BASED REWRITE FAILS. An isolated chunk after quiet — a
// keystroke coming back — must not wait for the window. Measured at the
// daemon's real 6ms, sampled the way typing actually arrives.
{
  // MEASURED FROM PUSH TO SHIP, not from push to return.
  //
  // The first cut of this section timed how long `push` took to come back,
  // which is the one measurement that cannot see the regression: a plain
  // `setTimeout(flush, windowMs)` returns instantly too, and then ships 6ms
  // later. Mutating the outbox to exactly that — the rewrite this whole test
  // exists to catch — passed the suite. So the clock now stops in `ship`.
  const waits = [];
  let pushedAt = 0n;
  const box = createOutbox(() => {
    waits.push(Number(process.hrtime.bigint() - pushedAt) / 1e6);
  });
  const SAMPLES = 60;
  for (let i = 0; i < SAMPLES; i++) {
    // Quiet, the way it is between two keystrokes.
    await new Promise((r) => setTimeout(r, OUT_COALESCE_MS + 4));
    pushedAt = process.hrtime.bigint();
    box.push(Buffer.from('x'));
  }
  await new Promise((r) => setTimeout(r, OUT_COALESCE_MS * 4));
  const p50 = measure('echo latency p50', pct(waits, 0.5), 'ms');
  const p95 = measure('echo latency p95', pct(waits, 0.95), 'ms');
  measure('echo latency max', Math.max(...waits), 'ms');
  check('an isolated chunk reaches the wire without waiting for the window', p95 < 1,
    `p50 ${fmt(p50)}ms, p95 ${fmt(p95)}ms — a plain timer measures ~${OUT_COALESCE_MS}ms here`);
  check('…and every one of them really did ship', waits.length === SAMPLES,
    `${waits.length}/${SAMPLES}`);
}

// ---- D. echo under load ----------------------------------------------------
//
// The two halves together, which is the real situation: output pouring in
// while somebody types. A gather in progress DOES hold a keystroke to the end
// of the window — that is the design, and this pins the cost at one window
// rather than letting it drift into "however long the burst lasts".
{
  const seen = [];
  const box = createOutbox((b64) => seen.push(Buffer.from(b64, 'base64').toString('utf8')));
  const t0 = Date.now();
  const stop = t0 + 300;
  let typed = 0;
  const marks = [];
  while (Date.now() < stop) {
    for (let i = 0; i < 200; i++) box.push(Buffer.from('.'.repeat(64)));
    const at = Date.now();
    box.push(Buffer.from(`<K${typed}>`));
    marks.push(at);
    typed++;
    await new Promise((r) => setImmediate(r));
  }
  box.flush();
  const text = seen.join('');
  const arrived = marks.filter((_, i) => text.includes(`<K${i}>`)).length;
  check('a keystroke is never lost behind a burst', arrived === typed, `${arrived}/${typed} echoed`);
  check('…and stays in order within it',
    text.indexOf('<K0>') < text.indexOf(`<K${typed - 1}>`));
  measure('frames for a 300ms flood', seen.length, 'frames');
  const perWindow = seen.length / (300 / OUT_COALESCE_MS);
  check('a sustained flood costs about one frame per window, not more', perWindow <= 1.5,
    `${fmt(perWindow)} frames per ${OUT_COALESCE_MS}ms window`);
}

// ---- E. the real pty, end to end -------------------------------------------
//
// The actual stack: python3 pty-shim.py → a pipe → node → the outbox. `cat` of
// a large file, because that is the shape of every real flood (a log tail, a
// build's output, a `git diff` nobody expected to be big).
{
  const dir = mkdtempSync(join(tmpdir(), 'stack-termperf-'));
  const file = join(dir, 'flood.txt');
  const LINES = 40000;
  const line = 'the quick brown fox jumps over the lazy dog 0123456789 ';
  writeFileSync(file, `${line}\n`.repeat(LINES) + 'ENDOFFLOOD\n');

  const naive = { frames: 0, bytes: 0 };   // what the daemon did BEFORE the outbox
  const sent = [];
  const box = createOutbox((b64) => sent.push(b64));

  const t0 = process.hrtime.bigint();
  const child = spawn('python3', [SHIM, dir, '/bin/bash', '-lc', `cat ${file}; exit`], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.stdout.on('data', (d) => { naive.frames++; naive.bytes += d.length; box.push(d); });
  child.stderr.resume();

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 60_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  box.flush();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rmSync(dir, { recursive: true, force: true });

  if (spawnError) die(`the pty shim would not spawn: ${spawnError.message}`);
  if (code === 'timeout') die('the pty shim did not finish within 60s — nothing was measured.');
  if (naive.bytes === 0) die('the pty shim produced no output — nothing was measured.');

  const mb = naive.bytes / 1024 / 1024;
  measure('pty volume', mb, 'MB');
  const rate = measure('pty pipeline throughput', (mb * 1000) / ms, 'MB/s');
  measure('kernel reads (frames before the outbox)', naive.frames, 'frames');
  measure('frames after the outbox', sent.length, 'frames');
  const saved = measure('websocket frames avoided', (1 - sent.length / naive.frames) * 100, '%');

  const text = Buffer.concat(sent.map((b) => Buffer.from(b, 'base64'))).toString('utf8');
  check('every byte of a real pty flood arrives', text.includes('ENDOFFLOOD'));
  check('…and the tail is not cut short by the exit flush',
    text.trimEnd().endsWith('ENDOFFLOOD'), `${fmt(mb)}MB through the real shim`);
  check('the outbox collapses a real flood, not just a synthetic one',
    sent.length < naive.frames, `${naive.frames} reads → ${sent.length} frames (${fmt(saved)}% fewer)`);
  check('a pty flood moves at a sane rate', rate > 1, `${fmt(rate)} MB/s (floor 1)`);
}

// ---- F. the replay buffer under a long outage ------------------------------
//
// A redeploy takes the uplink down while sessions keep talking. This is the
// memory bound, and it is a performance property: unbounded here is the daemon
// growing until the host kills it, taking every live session with it.
{
  const rb = createReplayBuffer();
  const frame = Buffer.alloc(16384, 'q').toString('base64');
  const N = 20000; // ~440MB of output if nothing were dropped
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) rb.push(frame);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const held = measure('replay buffer held', rb.stats.bytes / 1024, 'KB');
  measure('replay push cost', (N / ms) / 1000, 'M pushes/s');
  const offered = (N * frame.length) / 1024 / 1024;
  check('a long outage cannot grow the daemon without bound',
    rb.stats.bytes <= rb.stats.capBytes + frame.length,
    `${fmt(offered)}MB offered, ${fmt(held)}KB held`);
  check('…and the drops are counted rather than silent', rb.stats.dropped > 0);
  check('the newest output is what survived',
    rb.drain().every((f) => f === frame));
}

// ---- the numbers -----------------------------------------------------------

const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\n${'─'.repeat(w + 22)}`);
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${fmt(r.value).padStart(8)} ${r.unit}`);
console.log('─'.repeat(w + 22));

if (REPORT_ONLY) { console.log('\nreport only — no thresholds applied.'); process.exit(0); }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
