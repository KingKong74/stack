// The terminal daemon's OUTBOX — how a session's bytes become websocket frames.
//
// This is the hot path of the whole web terminal, and it is here as its own
// module for two reasons: stack-term.mjs cannot be imported (it dials the API
// and sets intervals at load), and a thing nobody can import is a thing nobody
// can measure. server/test/out-coalesce.test.mjs pins the behaviour;
// scripts/term-perf.test.mjs measures the cost.
//
// WHAT IT IS FOR. Every byte a session produces leaves as a JSON frame
// carrying base64 — about 1.4x the bytes, plus a parse at both ends. A pty
// hands us whatever the kernel had ready, so a repainting TUI (claude's own
// spinner, a build's progress bar) arrives as dozens of tiny reads per frame,
// each of which was becoming its own websocket message. The browser already
// merges what it RECEIVES into one write per animation frame (#135); this is
// the same idea one hop earlier, where the per-frame cost is actually paid.
//
// IDLE OUTPUT IS NEVER DELAYED, and that is the invariant the whole shape
// exists to protect. A plain timer would add its full window to every
// keystroke echo — the one latency a terminal must not have. So the rule is:
// if nothing has gone out for at least the window, go NOW; only a second chunk
// arriving INSIDE the window starts gathering, which is by definition a burst.
// Typing pays nothing. A screenful pays one frame instead of thirty.
//
// ORDER is why every output path goes through one outbox rather than only the
// hot one. The daemon's own prompts (the model switch) are written as text,
// and a direct send from there would overtake pty output still sitting in the
// pending buffer — the prompt would print above the text it is answering.
//
// THE WINDOW IS 6ms and that is not arbitrary: it is comfortably under one
// 60Hz frame (16.7ms), so a burst gathered here still lands inside the same
// animation frame the browser was going to paint anyway. Raising it past 16
// would start costing visible latency for no further saving, because the
// browser cannot paint the extra frames it would save.

export const OUT_COALESCE_MS = 6;

// Create an outbox for one session.
//
// `ship(base64)` is called with each finished frame's payload. It is the
// caller's — the daemon's — because only the daemon knows whether the uplink
// is up and where the bytes go when it is not; keeping that out of here is
// what makes this module testable without a websocket.
//
// `windowMs` exists for the tests. Nothing in the daemon passes it.
export function createOutbox(ship, { windowMs = OUT_COALESCE_MS } = {}) {
  // Gathered chunks are held as a LIST and joined once at flush, never
  // concatenated as they arrive. Concatenating per push copies the whole
  // accumulated buffer every time, which is quadratic in the length of a
  // burst — and a burst is precisely the case this module exists for, so the
  // cost lands exactly where it hurts. Measured over a 20k-chunk burst: 415ms
  // concatenating per push, 2.9ms gathering into a list, and the gap WIDENS
  // with the length of the burst because one is quadratic and the other is
  // not. The real pty flood in scripts/term-perf.test.mjs never gathers enough
  // per window to show this, which is why that suite carries the synthetic
  // burst as well — the honest measurement needs both shapes.
  let pend = [];        // chunks gathered but not yet framed
  let pendBytes = 0;
  let timer = null;     // the timeout that will frame them
  let last = 0;         // when a frame last went out (epoch ms)
  let frames = 0;       // how many frames this outbox has shipped
  let bytes = 0;        // how many raw bytes went into them

  // Send whatever has gathered. Safe to call at any time, including with
  // nothing pending — the exit path leans on that.
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pendBytes === 0) return;
    // One chunk is the common case (an isolated keystroke echo) and needs no
    // copy at all.
    const buf = pend.length === 1 ? pend[0] : Buffer.concat(pend, pendBytes);
    pend = [];
    pendBytes = 0;
    last = Date.now();
    frames++;
    bytes += buf.length;
    ship(buf.toString('base64'));
  };

  return {
    // The one door out. Takes a Buffer.
    push(buf) {
      if (!buf || buf.length === 0) return;
      pend.push(buf);
      pendBytes += buf.length;
      if (timer) return; // already gathering this burst
      const since = Date.now() - last;
      if (since >= windowMs) { flush(); return; }
      // `unref` so a session's outbox can never be the reason the daemon's
      // event loop stays alive. The timer is at most 6ms; holding the process
      // open for it would be absurd, and a test that hangs on one is worse.
      timer = setTimeout(flush, windowMs - since);
      timer.unref?.();
    },

    // Ship the tail immediately. Called before the exit frame: without it the
    // last words of a session — a stack trace, a shell's goodbye — sit in the
    // pending buffer while the browser is told the session ended, and are then
    // dropped.
    flush,

    // Drop the timer without shipping. For a session being torn down whose
    // bytes have nowhere left to go.
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      pend = [];
      pendBytes = 0;
    },

    // What this outbox has done — read by the perf harness, and by nothing in
    // the daemon. `pending` is what a flush would ship right now.
    get stats() { return { frames, bytes, pending: pendBytes }; },
  };
}

// THE REPLAY BUFFER — where frames go while the browser is not on the line.
//
// The uplink drops on every server redeploy and every network blip, and the
// session on the host keeps running and keeps talking. What it says has to be
// held so a reconnecting browser can catch up, and held BOUNDED, because "the
// uplink has been down for an hour" is a normal state and an unbounded hold is
// the daemon growing until the host kills it.
//
// It drops the OLDEST frame when full, which is the right end for a terminal:
// the newest output is the screen you are about to look at, and the oldest is
// scrollback you have already lost the top of anyway.
//
// Frames are held base64-ENCODED — already framed, ready to send. That costs
// ~1.35x the raw bytes, and it is deliberate: it means a reconnect is a loop
// of sends with no work in it, and the cap counts the bytes actually held
// rather than the bytes they came from.
export const REPLAY_CAP_BYTES = 256 * 1024;

export function createReplayBuffer({ capBytes = REPLAY_CAP_BYTES } = {}) {
  let chunks = [];
  let bytes = 0;
  let dropped = 0;
  return {
    push(b64) {
      chunks.push(b64);
      bytes += b64.length;
      // `> 1`, not `> 0`: THE NEWEST FRAME IS NEVER DROPPED, even when it
      // alone exceeds the cap. A single frame can: it is one coalescing
      // window's worth of output, and a `cat` of a large file moves more than
      // 256KB in 6ms. Evicting to satisfy the cap would empty the buffer
      // completely, so a browser reconnecting after a burst would be handed
      // NOTHING — having dropped, to save memory, the exact screen the buffer
      // exists to preserve. The bound is therefore cap + one frame, which is
      // still a bound; the next push evicts the oversized frame like any
      // other.
      while (bytes > capBytes && chunks.length > 1) {
        bytes -= chunks.shift().length;
        dropped++;
      }
    },
    // Hand over everything held and forget it. One call rather than a read
    // plus a reset: two steps is how a reconnect that throws halfway replays
    // the same frames twice.
    drain() {
      const out = chunks;
      chunks = [];
      bytes = 0;
      return out;
    },
    get stats() { return { frames: chunks.length, bytes, dropped, capBytes }; },
  };
}
