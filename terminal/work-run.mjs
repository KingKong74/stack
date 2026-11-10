// HOW LONG A SESSION HAS WORKED, measured on the host so it is true whether or
// not a browser was watching. Pure: the daemon feeds it one pane read per block-
// watch tick (20s) and keeps what it returns.
//
// WORK = THE PANE CHANGED between two reads. tmux's own session_activity is no
// use here: it does not move while no client is attached, which is exactly when
// this has to keep counting. A working claude redraws its spinner constantly; a
// session sitting at its prompt draws nothing, so an unchanged pane is a stop.
//
// A RUN spans pauses up to RUN_GAP_MS (a bit over two ticks, so one read that
// happened to land on a still frame does not split it); a longer stop ends it
// and the next change starts a new one. A run is never cleared: an idle session
// still says how long it last worked, and that is the number the owner reads
// after coming back to a closed browser.
//
// The first read of a session (no previous signature: a new session, or a
// daemon that just restarted) is a BASELINE, never a change. Restart keeps the
// run itself, because the daemon stores it on the tmux session (@stack-run).
export const RUN_GAP_MS = 45_000;

/** prev: { sig?, start, last } | undefined → { sig, start, last } (0 = never worked). */
export function trackRun(prev, sig, now) {
  const start = prev?.start || 0;
  const last = prev?.last || 0;
  if (!prev || prev.sig === undefined || prev.sig === sig) return { sig, start, last };
  if (last && now - last <= RUN_GAP_MS) return { sig, start, last: now };
  return { sig, start: now, last: now };
}

/** Is the run still going at `now`? */
export const runWorking = (r, now) => !!(r && r.last && now - r.last <= RUN_GAP_MS);

/** The @stack-run option's value, both ways. Anything malformed reads as no run. */
export const encodeRun = (r) => `${r.start}:${r.last}`;
export function decodeRun(v) {
  const m = /^(\d{10,16}):(\d{10,16})$/.exec(String(v || ''));
  if (!m) return null;
  const start = Number(m[1]), last = Number(m[2]);
  return start > 0 && last >= start ? { start, last } : null;
}
