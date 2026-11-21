// SWIPE TO SCROLL A TERMINAL ON A TOUCH SCREEN.
//
// xterm turns a mouse WHEEL into scrolling, and nothing else: a finger drag
// never becomes a wheel, so on a phone a terminal could not be scrolled at
// all. Every Stack session also runs inside tmux with `mouse on`
// (terminal/tmux-session.mjs), so a wheel there is not even xterm's to act on.
// xterm encodes it as a mouse report, and tmux answers it by entering copy mode
// and scrolling its own history.
//
// So a swipe goes one of two ways, decided per move by what the program in
// the terminal asked for:
//  • MOUSE MODE (tmux, and anything else that turned on mouse reporting): the
//    swipe becomes the SAME wheel events a desktop sends, dispatched at
//    xterm's screen, and xterm encodes them as reports. Events rather than
//    escape sequences written here, because the encoding (SGR or X10, which
//    button numbers) is negotiated between the program and xterm, and a
//    second spelling of it here would drift. One wheel is one report and tmux
//    moves several lines per report, so one goes per few rows of travel and
//    the text roughly follows the finger.
//  • OTHERWISE (a plain shell tab): xterm's own scrollback moves, through its
//    public scrollLines. xterm 6's viewport ignores a dispatched wheel.
//
// A tap is left alone (no preventDefault until the finger has moved), so a tap
// still focuses the terminal and raises the keyboard. A flick keeps going
// briefly and slows to a stop, like any other scrolling surface on a phone.

import type { Terminal } from '@xterm/xterm';

const SLOP_PX = 8;          // movement before a touch counts as a swipe
const ROWS_PER_REPORT = 3;  // finger travel, in rows, per mouse-mode wheel
const FRICTION = 0.92;      // per-frame decay of a flick
const MIN_FLING = 0.05;     // px/ms below which a flick stops

export function wireTouchScroll(term: Terminal, holder: HTMLElement): () => void {
  let startX = 0, startY = 0, lastY = 0, lastT = 0, velocity = 0;
  let swiping = false, tracking = false;
  let pending = 0;          // finger travel not yet turned into lines or reports
  let flingFrame: number | undefined;

  const screen = () => holder.querySelector('.xterm-screen') as HTMLElement | null;
  const cellHeight = () => {
    const el = screen();
    return el && term.rows ? el.clientHeight / term.rows : 16;
  };
  const mouseMode = () => term.modes.mouseTrackingMode !== 'none';

  const wheel = (deltaY: number, x: number, y: number) => {
    const el = screen();
    if (!el || !deltaY) return;
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  };

  // Moves the view by `dy` px of finger travel (positive = finger moved up,
  // so later output comes into view, as with any touch scroller).
  const scrollBy = (dy: number, x: number, y: number) => {
    pending += dy;
    if (!mouseMode()) {
      const lines = Math.trunc(pending / cellHeight());
      if (lines) { term.scrollLines(lines); pending -= lines * cellHeight(); }
      return;
    }
    const step = cellHeight() * ROWS_PER_REPORT;
    while (Math.abs(pending) >= step) {
      const dir = Math.sign(pending);
      // Comfortably over one row, so xterm counts it as exactly one report.
      wheel(dir * Math.max(60, cellHeight() * 1.5), x, y);
      pending -= dir * step;
    }
  };

  const stopFling = () => {
    if (flingFrame !== undefined) cancelAnimationFrame(flingFrame);
    flingFrame = undefined;
  };

  const onStart = (e: TouchEvent) => {
    stopFling();
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    startX = t.clientX; startY = lastY = t.clientY; lastT = e.timeStamp;
    velocity = 0; pending = 0; swiping = false; tracking = true;
  };

  const onMove = (e: TouchEvent) => {
    if (!tracking || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!swiping) {
      const dx = t.clientX - startX, dy = t.clientY - startY;
      // A sideways drag is not ours: let the page have it.
      if (Math.abs(dy) < SLOP_PX || Math.abs(dy) < Math.abs(dx)) return;
      swiping = true;
    }
    e.preventDefault();
    const dy = lastY - t.clientY;
    const dt = Math.max(1, e.timeStamp - lastT);
    velocity = 0.8 * (dy / dt) + 0.2 * velocity;
    lastY = t.clientY; lastT = e.timeStamp;
    scrollBy(dy, t.clientX, t.clientY);
  };

  const onEnd = () => {
    if (!tracking) return;
    tracking = false;
    if (!swiping || Math.abs(velocity) < MIN_FLING) return;
    let v = velocity, prev = performance.now();
    const x = startX, y = lastY;
    const step = (now: number) => {
      const dt = Math.min(48, now - prev); prev = now;
      scrollBy(v * dt, x, y);
      v *= Math.pow(FRICTION, dt / 16);
      flingFrame = Math.abs(v) < MIN_FLING ? undefined : requestAnimationFrame(step);
    };
    flingFrame = requestAnimationFrame(step);
  };

  holder.addEventListener('touchstart', onStart, { passive: true });
  holder.addEventListener('touchmove', onMove, { passive: false });
  holder.addEventListener('touchend', onEnd);
  holder.addEventListener('touchcancel', onEnd);
  return () => {
    stopFling();
    holder.removeEventListener('touchstart', onStart);
    holder.removeEventListener('touchmove', onMove);
    holder.removeEventListener('touchend', onEnd);
    holder.removeEventListener('touchcancel', onEnd);
  };
}
