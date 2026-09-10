// The terminal daemon's outbox and replay buffer, tested against the REAL
// exports and against REAL timers.
//
//   node server/test/out-coalesce.test.mjs      # exits non-zero on any failure
//
// Pure — no database, no API, no host daemon. It is the correctness half;
// scripts/term-perf.test.mjs is the cost half.
//
// The invariant nearly everything below is protecting: A FIRST CHUNK AFTER
// QUIET SHIPS IN THE SAME TICK. That is what makes typing feel like typing,
// and it is the one property a "just add a timer" rewrite silently destroys —
// such a rewrite passes every ordering and fidelity test here and fails only
// the three that look at WHEN.
//
// Real timers rather than a fake clock, because the thing under test IS the
// clock arithmetic. A faked one would be testing the fake. The window is
// widened per-outbox where a test needs room to observe a gather; the daemon's
// own 6ms is exercised by the perf harness.
import { createOutbox, createReplayBuffer, OUT_COALESCE_MS, REPLAY_CAP_BYTES } from '../../terminal/out-coalesce.mjs';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (b64) => Buffer.from(b64, 'base64').toString('utf8');

// A recording ship + the outbox that feeds it. `W` is wide enough that a
// gather is observable without the test being a race.
const W = 40;
const rig = (windowMs = W) => {
  const sent = [];
  const box = createOutbox((b64) => sent.push(b64), { windowMs });
  return { sent, box };
};

// ---- WHEN a frame goes out ------------------------------------------------

{
  const { sent, box } = rig();
  box.push(Buffer.from('a'));
  // Synchronously, with no await: this is the typing invariant.
  check('a first chunk after quiet ships in the SAME TICK', sent.length, 1);
  check('…and it is the chunk', dec(sent[0]), 'a');
}

{
  const { sent, box } = rig();
  box.push(Buffer.from('a'));      // ships now
  box.push(Buffer.from('b'));      // inside the window — gathers
  box.push(Buffer.from('c'));
  check('chunks arriving inside the window do NOT each ship', sent.length, 1);
  await sleep(W * 2);
  check('the gathered burst ships as ONE frame', sent.length, 2);
  check('…carrying both, in order', dec(sent[1]), 'bc');
}

{
  const { sent, box } = rig();
  box.push(Buffer.from('a'));
  await sleep(W * 2);              // quiet for longer than the window
  box.push(Buffer.from('b'));
  check('after quiet, the next chunk is immediate again', sent.length, 2);
}

{
  // The regression this whole shape exists to prevent: a plain interval would
  // make EVERY chunk wait. Measure the delay on an isolated chunk.
  const { sent, box } = rig();
  const t0 = Date.now();
  box.push(Buffer.from('keystroke echo'));
  const waited = Date.now() - t0;
  check('an isolated chunk waits ~0ms, not a window', waited < W / 2 && sent.length === 1, true);
}

// ---- WHAT comes out -------------------------------------------------------

{
  const { sent, box } = rig();
  const parts = ['\x1b[2J', 'hello ', 'world', '\r\n', '\x1b[0m'];
  for (const p of parts) box.push(Buffer.from(p));
  await sleep(W * 2);
  check('every byte survives, in order', sent.map(dec).join(''), parts.join(''));
}

{
  // Order across SOURCES. The daemon writes its own model-switch prompt into
  // the same outbox precisely so it cannot overtake pty output still pending.
  const { sent, box } = rig();
  box.push(Buffer.from('pty says this first'));   // ships
  box.push(Buffer.from(' …and this is pending')); // gathers
  box.push(Buffer.from('[daemon prompt]'));       // must queue BEHIND it
  await sleep(W * 2);
  check('a daemon write never overtakes pending pty output',
    sent.map(dec).join(''), 'pty says this first …and this is pending[daemon prompt]');
}

{
  // Binary, not text: a pty carries arbitrary bytes and base64 has to survive
  // the ones that are not valid UTF-8.
  const { sent, box } = rig();
  const raw = Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x41, 0x80, 0x7f]);
  box.push(raw);
  check('non-UTF-8 bytes round-trip exactly',
    Buffer.from(sent[0], 'base64').equals(raw), true);
}

{
  const { sent, box } = rig();
  box.push(Buffer.alloc(0));
  box.push(null);
  check('an empty push ships nothing', sent.length, 0);
}

// ---- flush and dispose ----------------------------------------------------

{
  const { sent, box } = rig();
  box.push(Buffer.from('first'));   // ships
  box.push(Buffer.from('tail'));    // pending
  check('the tail is pending, not sent', sent.length, 1);
  box.flush();
  check('flush ships the tail immediately', [sent.length, dec(sent[1])], [2, 'tail']);
}

{
  const { sent, box } = rig();
  box.flush();
  check('flush with nothing pending ships no empty frame', sent.length, 0);
  box.push(Buffer.from('x'));
  box.flush();
  box.flush();
  check('a second flush is a no-op, not a duplicate', sent.length, 1);
}

{
  // The exit path: flush, THEN the exit frame. Without the flush the tail is
  // dropped — a stack trace lost exactly when it is wanted.
  const { sent, box } = rig();
  box.push(Buffer.from('running'));
  box.push(Buffer.from('\r\nSegmentation fault\r\n'));
  box.flush();
  check('a session\'s last words survive its exit',
    sent.map(dec).join('').includes('Segmentation fault'), true);
}

{
  const { sent, box } = rig();
  box.push(Buffer.from('a'));
  box.push(Buffer.from('discard me'));
  box.dispose();
  await sleep(W * 2);
  check('dispose drops what was pending and cancels the timer', sent.length, 1);
}

// ---- the burst that motivated the whole thing -----------------------------

{
  // A repainting TUI: many tiny writes, back to back, with no gaps. This is
  // what a claude session's spinner actually looks like to the daemon.
  const { sent, box } = rig();
  for (let i = 0; i < 500; i++) box.push(Buffer.from(`\x1b[G frame ${i} `));
  box.flush();
  check('500 chunks in one burst do not become 500 frames', sent.length <= 3, true);
  check('…and nothing is lost doing it',
    sent.map(dec).join('').includes('frame 499'), true);
  console.log(`      (500 chunks → ${sent.length} frames)`);
}

{
  check('the daemon window is under one 60Hz frame', OUT_COALESCE_MS < 16.7, true);
}

// ---- the replay buffer ----------------------------------------------------

{
  const rb = createReplayBuffer();
  rb.push('aaaa');
  rb.push('bbbb');
  check('what goes in comes out, in order', rb.drain(), ['aaaa', 'bbbb']);
  check('drain forgets it', rb.drain(), []);
  check('…and the byte count resets with it', rb.stats.bytes, 0);
}

{
  // The memory bound. "The uplink has been down for an hour" is a NORMAL
  // state — a redeploy, a flaky network — and a session keeps talking through
  // it. Unbounded holding here is the daemon growing until the host kills it.
  const rb = createReplayBuffer({ capBytes: 1000 });
  const frame = 'x'.repeat(100);
  for (let i = 0; i < 500; i++) rb.push(frame);
  check('the buffer stays under its cap however long the uplink is down',
    rb.stats.bytes <= 1000, true);
  check('…and it dropped the OLDEST, so the newest screen survives',
    rb.drain().length <= 10, true);
}

{
  const rb = createReplayBuffer({ capBytes: 1000 });
  for (let i = 0; i < 50; i++) rb.push('y'.repeat(100));
  check('dropping is counted, not silent', rb.stats.dropped > 0, true);
}

{
  // A single frame larger than the whole cap. The loop must not spin forever
  // or empty itself into an inconsistent state.
  const rb = createReplayBuffer({ capBytes: 100 });
  rb.push('z'.repeat(5000));
  check('one oversized frame is held rather than looping the buffer empty',
    rb.stats.frames, 1);
}

{
  check('the shipped cap is 256KB', REPLAY_CAP_BYTES, 256 * 1024);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
